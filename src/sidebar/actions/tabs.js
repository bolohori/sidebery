import Utils from '../../libs/utils'
import EventBus from '../event-bus'

let TabsTreeSaveTimeout

export default {
  /**
   * Load all tabs for current window
   */
  async loadTabs({ state, getters }) {
    const windowId = browser.windows.WINDOW_ID_CURRENT
    const tabs = await browser.tabs.query({ windowId })

    // Check order of tabs and get moves for normalizing
    const ctxs = [getters.defaultCtxId]
      .concat(state.containers.filter(c => c.type === 'ctx').map(c => c.cookieStoreId))
    const moves = []
    let index = tabs.filter(t => t.pinned).length
    let offset = 0
    for (let i = 0; i < ctxs.length; i++) {
      const ctx = ctxs[i]
      for (let j = 0; j < tabs.length; j++) {
        const tab = tabs[j]
        if (tab.pinned) continue
        if (tab.cookieStoreId !== ctx) continue

        if (index !== tab.index + offset) {
          moves.push([tab.id, index])
          offset++
        }
        index++
      }
    }

    // Set tabs initial props and update state
    tabs.forEach(t => {
      t.isParent = false
      t.folded = false
      t.parentId = -1
      t.invisible = false
      t.lvl = 0
    })
    state.tabs = tabs

    // Normalize order
    moves.map(async move => {
      await browser.tabs.move(move[0], { index: move[1] })
    })

    // Restore tree levels
    if (state.tabsTree) {
      const ans = await browser.storage.local.get('tabsTreeState')
      if (ans.tabsTreeState) {
        const parents = []
        for (let t of ans.tabsTreeState) {
          const tab = state.tabs[t.index]

          // Check if this is actual target tab
          if (!tab) break
          if (tab.url !== t.url) break
          if (tab.cookieStoreId !== t.ctx) break

          tab.isParent = t.isParent
          tab.folded = t.folded
          if (t.isParent) parents[t.id] = tab
          if (t.parentId > -1) {
            const parentTab = parents[t.parentId]
            if (parentTab.folded) {
              tab.invisible = true
            } else tab.invisible = false
            tab.parentId = parentTab.id
          }
        }
      }

      state.tabs = Utils.CalcTabsTreeLevels(state.tabs)
    }
  },

  /**
   * Save tabs tree
   */
  saveTabsTree({ state }, delay = 1000) {
    if (TabsTreeSaveTimeout) clearTimeout(TabsTreeSaveTimeout)
    TabsTreeSaveTimeout = setTimeout(async () => {
      const tabsTreeState = []
      for (let t of state.tabs) {
        if (t.isParent || t.parentId > -1) {
          tabsTreeState.push({
            id: t.id,
            index: t.index,
            url: t.url,
            ctx: t.cookieStoreId,
            isParent: t.isParent,
            folded: t.folded,
            parentId: t.parentId,
          })
        }
      }
      await browser.storage.local.set({ tabsTreeState })
      TabsTreeSaveTimeout = null
    }, delay)
  },

  /**
   * Create new tab in current window
   */
  createTab({ state, getters }, ctxId) {
    if (!ctxId) return
    let p = getters.panels.find(p => p.cookieStoreId === ctxId)
    if (!p || !p.tabs) return
    let index = p.tabs.length ? p.endIndex + 1 : p.startIndex
    browser.tabs.create({ index, cookieStoreId: ctxId, windowId: state.windowId })
  },

  /**
   * Remove tab.
   */
  async removeTab({ state, getters, dispatch }, tab) {
    // console.log('[DEBUG] TABS ACTION removeTab');
    let p = Utils.GetPanelOf(getters.panels, tab)
    if (!p || !p.tabs) return
    if (p.lockedTabs && tab.url.indexOf('about')) {
      return
    }

    if (tab.folded) dispatch('expTabsBranch', tab.id)

    if (p && p.noEmpty) {
      const panelIndex = Utils.GetPanelIndex(getters.panels, tab.id)
      const panelTabs = getters.panels[panelIndex].tabs
      if (panelTabs && panelTabs.length === 1) {
        await browser.tabs.create({ cookieStoreId: p.id })
      }
    }

    if (tab.index === p.endIndex && p.tabs.length > 1 && tab.active) {
      let prevTab = state.tabs[p.endIndex - 1]
      if (prevTab.invisible && prevTab.parentId >= 0) {
        await browser.tabs.update(prevTab.parentId, { active: true })
      } else {
        await browser.tabs.update(prevTab.id, { active: true })
      }
    }
    browser.tabs.remove(tab.id)
  },

  /**
   * Remove tabs
   */
  async removeTabs({ state, getters, dispatch }, tabIds) {
    // console.log('[DEBUG] TABS ACTION removeTabs');
    const tabs = []
    const toRemove = []
    let panelId = undefined
    let firstIndex, lastIndex

    // Find tabs to remove
    for (let id of tabIds) {
      const tab = state.tabs.find(t => t.id === id)
      if (!tab) continue
      const panel = getters.panels.find(p => p.id === tab.cookieStoreId)
      if (!panel) {
        toRemove.push(tab.id)
        continue
      }
      if (tab.folded) dispatch('expTabsBranch', id)
      if (panel.lockedTabs && tab.url.indexOf('about')) continue
      if (panelId === undefined) panelId = tab.cookieStoreId
      if (panelId && panelId !== tab.cookieStoreId) panelId = null
      if (firstIndex === undefined) firstIndex = tab.index
      else if (firstIndex > tab.index) firstIndex = tab.index
      if (lastIndex === undefined) lastIndex = tab.index
      else if (lastIndex < tab.index) lastIndex = tab.index
      tabs.push(tab)
      toRemove.push(tab.id)
    }

    // Check if all tabs from the same panel
    // and find that panel
    let panel
    if (panelId) {
      panel = getters.panels.find(p => p.cookieStoreId === panelId)
    }

    // If there are no tabs on this panel
    // create new one (if that option accepted)
    if (
      panel &&
      toRemove.length === panel.tabs.length &&
      panel.noEmpty
    ) {
      await browser.tabs.create({ active: true })
    }

    // Try to activate prev or next tab on this panel
    // if there are some other tabs and if
    // all removed tabs from the same panel
    if (panel && toRemove.length < panel.tabs.length) {
      const activeTab = tabs.find(t => t.active)

      if (activeTab && activeTab.cookieStoreId === panelId) {
        let toActivate = panel.tabs.find(t => t.index === firstIndex - 1)
        if (!toActivate) toActivate = panel.tabs.find(t => t.index === lastIndex + 1)
        if (toActivate) await browser.tabs.update(toActivate.id, { active: true })
      }
    }

    browser.tabs.remove(toRemove)
  },

  /**
   * Activate tab relatively current active tab.
   */
  switchTab({ state, getters }, { globaly, cycle, step, pinned }) {
    if (state.switchTabPause) return
    state.switchTabPause = setTimeout(() => {
      clearTimeout(state.switchTabPause)
      state.switchTabPause = null
    }, 50)

    let tabs
    if (state.pinnedTabsPosition === 'panel') {
      tabs = []
      if (globaly) {
        for (let p of getters.panels) {
          if (!p.cookieStoreId) continue
          for (let t of state.tabs) {
            if (t.cookieStoreId === p.cookieStoreId) tabs.push(t)
          }
        }
      } else {
        const p = getters.panels[state.panelIndex]
        tabs = state.tabs.filter(t => t.cookieStoreId === p.cookieStoreId)
      }
    } else {
      if (pinned) tabs = getters.pinnedTabs
      else tabs = globaly ? state.tabs : getters.panels[state.panelIndex].tabs
    }
    if (!tabs || !tabs.length) return

    let index = tabs.findIndex(t => t.active)
    if (step > 0) {
      index += step
      while (tabs[index] && tabs[index].invisible) index += step
      if (index >= tabs.length) {
        if (cycle) index = 0
        else return
      }
    }
    if (step < 0) {
      if (index < 0) index = tabs.length
      index += step
      while (tabs[index] && tabs[index].invisible) index += step
      if (index < 0) {
        if (cycle) index = tabs.length - 1
        else return
      }
    }

    browser.tabs.update(tabs[index].id, { active: true })
  },

  /**
   * Reload tabs
   */
  reloadTabs({ state }, tabIds = []) {
    for (let tabId of tabIds) {
      const tab = state.tabs.find(t => t.id === tabId)
      if (!tab) continue
      if (tab.url === 'about:blank' && tab.status === 'loading') continue
      browser.tabs.reload(tabId)
    }
  },

  /**
   * Discard tabs
   */
  discardTabs(_, tabIds = []) {
    browser.tabs.discard(tabIds)
  },

  /**
   * Try to activate last active tab on the panel
   */
  activateLastActiveTabOf({ getters }, panelIndex) {
    const p = getters.panels[panelIndex]
    if (!p || !p.tabs || !p.tabs.length) return
    const tab = p.tabs.find(t => t.id === p.lastActiveTab)
    if (tab && !tab.invisible) {
      browser.tabs.update(tab.id, { active: true })
    } else {
      let lastTab = p.tabs[p.tabs.length - 1]
      for (let i = p.tabs.length; i-- && lastTab.invisible; ) {
        lastTab = p.tabs[i]
      }
      if (lastTab) browser.tabs.update(lastTab.id, { active: true })
    }
  },

  /**
   * (un)Pin tabs
   */
  pinTabs(_, tabIds) {
    for (let tabId of tabIds) browser.tabs.update(tabId, { pinned: true })
  },
  unpinTabs(_, tabIds) {
    for (let tabId of tabIds) browser.tabs.update(tabId, { pinned: false })
  },
  repinTabs({ state }, tabIds) {
    for (let tabId of tabIds) {
      let tab = state.tabs.find(t => t.id === tabId)
      if (!tab) continue
      browser.tabs.update(tabId, { pinned: !tab.pinned })
    }
  },

  /**
   * (un)Mute tabs
   */
  muteTabs(_, tabIds) {
    for (let tabId of tabIds) browser.tabs.update(tabId, { muted: true })
  },
  unmuteTabs(_, tabIds) {
    for (let tabId of tabIds) browser.tabs.update(tabId, { muted: false })
  },
  remuteTabs({ state }, tabIds) {
    for (let tabId of tabIds) {
      let tab = state.tabs.find(t => t.id === tabId)
      if (!tab) continue
      browser.tabs.update(tabId, { muted: !tab.mutedInfo.muted })
    }
  },

  /**
   * Duplicate tabs
   */
  duplicateTabs({ state }, tabIds) {
    for (let tabId of tabIds) {
      let tab = state.tabs.find(t => t.id === tabId)
      if (!tab) continue
      // if (state.lockedPanels.includes(tab.cookieStoreId)) continue
      browser.tabs.duplicate(tabId)
    }
  },

  /**
   * Create bookmarks from tabs
   */
  bookmarkTabs({ state }, tabIds) {
    for (let tabId of tabIds) {
      let tab = state.tabs.find(t => t.id === tabId)
      if (!tab) continue
      browser.bookmarks.create({ title: tab.title, url: tab.url })
    }
  },

  /**
   * Clear all cookies of tab urls
   */
  async clearTabsCookies({ state }, tabIds) {
    try {
      const permitted = await browser.permissions.contains({ origins: ['<all_urls>'] })
      if (!permitted) {
        const url = browser.runtime.getURL('permissions/all-urls.html')
        browser.tabs.create({ url })
        return
      }
    } catch (err) {
      return
    }

    for (let tabId of tabIds) {
      let tab = state.tabs.find(t => t.id === tabId)
      if (!tab) continue

      EventBus.$emit('tabLoadingStart', tab.id)

      let url = new URL(tab.url)
      let domain = url.hostname
        .split('.')
        .slice(-2)
        .join('.')

      if (!domain) {
        EventBus.$emit('tabLoadingErr', tab.id)
        break
      }

      let cookies = await browser.cookies.getAll({
        domain: domain,
        storeId: tab.cookieStoreId,
      })
      let fpcookies = await browser.cookies.getAll({
        firstPartyDomain: domain,
        storeId: tab.cookieStoreId,
      })

      const clearing = cookies.concat(fpcookies).map(c => {
        return browser.cookies.remove({
          storeId: tab.cookieStoreId,
          url: tab.url,
          name: c.name,
        })
      })

      Promise.all(clearing)
        .then(() => setTimeout(() => EventBus.$emit('tabLoadingOk', tab.id), 250))
        .catch(() => setTimeout(() => EventBus.$emit('tabLoadingErr', tab.id), 250))
    }
  },

  /**
   * Create new window with first tab
   * and then move other tabs.
   */
  async moveTabsToNewWin({ state }, { tabIds, incognito }) {
    const first = tabIds.shift()
    const firstTab = state.tabs.find(t => t.id === first)
    if (!firstTab) return
    const rest = [...tabIds]

    if (state.private === incognito) {
      const win = await browser.windows.create({ tabId: first, incognito })
      browser.tabs.move(rest, { windowId: win.id, index: -1 })
    } else {
      const win = await browser.windows.create({ url: firstTab.url, incognito })
      browser.tabs.remove(first)
      for (let tabId of rest) {
        let tab = state.tabs.find(t => t.id === tabId)
        if (!tab) continue
        browser.tabs.create({ windowId: win.id, url: tab.url })
        browser.tabs.remove(tabId)
      }
    }
  },

  /**
   *  Move tabs to window if provided,
   * otherwise show window-choosing menu.
   */
  async moveTabsToWin({ state, dispatch }, { tabIds, window }) {
    const ids = [...tabIds]
    const windowId = window ? window.id : await dispatch('chooseWin')
    const win = (await Utils.GetAllWindows()).find(w => w.id === windowId)

    if (state.private === win.incognito) {
      browser.tabs.move(ids, { windowId, index: -1 })
    } else {
      for (let id of ids) {
        let tab = state.tabs.find(t => t.id === id)
        if (!tab) continue
        browser.tabs.create({ url: tab.url, windowId })
        browser.tabs.remove(id)
      }
    }
  },

  /**
   * Move tabs (reopen url) in provided context.
   */
  async moveTabsToCtx({ state }, { tabIds, ctxId }) {
    const ids = [...tabIds]
    for (let tabId of ids) {
      let tab = state.tabs.find(t => t.id === tabId)
      if (!tab) return

      await browser.tabs.create({
        cookieStoreId: ctxId,
        url: tab.url.indexOf('http') ? null : tab.url,
      })
      await browser.tabs.remove(tab.id)
    }
  },

  /**
   * Show all tabs
   */
  async showAllTabs({ state }) {
    const tabsToShow = state.tabs.filter(t => t.hidden).map(t => t.id)
    if (!tabsToShow.length) return null
    return browser.tabs.show(tabsToShow)
  },

  /**
   * (re)Hide inactive panels tabs
   */
  async hideInactPanelsTabs({ state, getters }) {
    // console.log('[DEBUG] TABS ACTION hideInactPanelsTabs');
    const actPI = state.panelIndex < 0 ? state.lastPanelIndex : state.panelIndex
    const actP = getters.panels[actPI]
    if (!actP || !actP.tabs || actP.pinned) return
    const toShow = actP.tabs.filter(t => t.hidden && !t.invisible).map(t => t.id)
    const toHide = getters.panels.reduce((acc, p, i) => {
      if (!p.tabs || p.tabs.length === 0) return acc
      if (i === actPI) return acc
      return acc.concat(p.tabs.filter(t => !t.hidden && !t.invisible).map(t => t.id))
    }, [])

    if (toShow.length) browser.tabs.show(toShow)
    if (toHide.length) browser.tabs.hide(toHide)
  },

  /**
   * Hide children of tab
   */
  async foldTabsBranch({ state, dispatch }, tabId) {
    // console.log('[DEBUG] TABS ACTION foldTabsBranch');
    const toHide = []
    for (let t of state.tabs) {
      if (t.id === tabId) t.folded = true
      if (t.parentId === tabId || toHide.includes(t.parentId)) {
        if (t.active) await browser.tabs.update(tabId, { active: true })
        if (!t.invisible) {
          toHide.push(t.id)
          t.invisible = true
        }
      }
    }

    await Utils.Sleep(120)

    if (state.hideFoldedTabs && toHide.length && state.ffVer >= 61) {
      browser.tabs.hide(toHide)
    }
    dispatch('saveTabsTree')
  },

  /**
   * Show children of tab
   */
  async expTabsBranch({ state, dispatch }, tabId) {
    // console.log('[DEBUG] TABS ACTION expTabsBranch');
    const toShow = []
    const preserve = []
    for (let t of state.tabs) {
      if (t.id === tabId) t.folded = false
      if (t.id !== tabId && t.folded) preserve.push(t.id)
      if (t.parentId === tabId || toShow.includes(t.parentId)) {
        if (t.invisible && t.parentId === tabId) {
          toShow.push(t.id)
          t.invisible = false
        }
        if (!preserve.includes(t.parentId)) {
          toShow.push(t.id)
          t.invisible = false
        }
      }
    }

    await Utils.Sleep(120)

    if (state.hideFoldedTabs && toShow.length && state.ffVer >= 61) {
      browser.tabs.show(toShow)
    }
    dispatch('saveTabsTree')
  },

  /**
   * Toggle tabs branch visability (fold/expand)
   */
  async toggleBranch({ state, dispatch }, tabId) {
    const rootTab = state.tabs.find(t => t.id === tabId)
    if (!rootTab) return
    if (rootTab.folded) dispatch('expTabsBranch', tabId)
    else dispatch('foldTabsBranch', tabId)
  },

  /**
   * Drop to tabs panel
   */
  async dropToTabs(
    { state, getters, dispatch },
    { event, dropIndex, dropParent, nodes, pin } = {}
  ) {
    // console.log('[DEBUG] TABS ACTION dropToTabs', dropIndex, dropParent);
    const destCtx = getters.panels[state.panelIndex].cookieStoreId
    const parent = state.tabs.find(t => t.id === dropParent)
    if (dropIndex === -1) dropIndex = getters.panels[state.panelIndex].endIndex + 1

    // Tabs or Bookmarks
    if (nodes && nodes.length) {
      const samePanel = nodes[0].panel === state.panelIndex

      // Reset drop to same place
      if (nodes[0].type === 'tab' && samePanel) {
        let k = nodes[0].index >= dropIndex ? dropIndex : dropIndex - 1
        for (let n of nodes) {
          if (k === n.index && dropParent !== n.id) continue
          if (k === n.index || dropParent === n.id) return
        }
      }

      if (nodes[0].type === 'tab' && samePanel && !event.ctrlKey) {
        // Pin/Unpin tab
        if (!pin && nodes[0].pinned) {
          for (let n of nodes) {
            await browser.tabs.update(n.id, { pinned: false })
          }
        }
        if (pin && !nodes[0].pinned) {
          for (let n of nodes) {
            const tab = state.tabs.find(t => t.id === n.id)
            // Skip group tab
            if (tab && tab.url.startsWith('moz-extension')) continue
            // Flatten
            if (tab) {
              tab.lvl = 0
              tab.parentId = -1
            }
            // Pin tab
            await browser.tabs.update(n.id, { pinned: true })
          }
        }

        // Move
        if (nodes[0].index !== dropIndex) {
          dropIndex = nodes[0].index > dropIndex ? dropIndex : dropIndex - 1
          browser.tabs.move(nodes.map(t => t.id), {
            windowId: state.windowId,
            index: dropIndex,
          })
        }

        // Hide tabs for folded branch or activate first node for expanded
        if (parent && parent.folded) {
          nodes.forEach(n => {
            const tab = state.tabs.find(t => t.id === n.id)
            if (tab) tab.invisible = true
          })
          if (state.hideFoldedTabs) browser.tabs.hide(nodes.map(t => t.id))
        } else {
          const tab = state.tabs.find(t => t.id === nodes[0].id)
          if (tab) tab.invisible = false
          browser.tabs.update(nodes[0].id, { active: true })
        }

        // Update tabs tree
        if (state.tabsTree) {
          if (nodes.length > 1 && nodes[0].id === nodes[1].parentId) {
            // If dragNodes is sub-tree, preserve struct
            const tab = state.tabs.find(t => t.id === nodes[0].id)
            if (tab) tab.parentId = dropParent >= 0 ? dropParent : -1
          } else {
            // Or just flatten all nodes
            for (let node of nodes) {
              const tab = state.tabs.find(t => t.id === node.id)
              if (tab) tab.parentId = dropParent >= 0 ? dropParent : -1
            }
          }

          // If there are no moving, just update tabs tree
          if (dropIndex === nodes[0].index) {
            state.tabs = Utils.CalcTabsTreeLevels(state.tabs, state.tabsTreeLimit)
          }
        }
      } else {
        // Create new tabs
        const oldNewMap = []
        for (let i = 0; i < nodes.length; i++) {
          const node = nodes[i]
          if (node.type === 'separator') continue
          if (!state.tabsTree && node.type !== 'bookmark') continue
          const groupPageUrl = browser.runtime.getURL('group/group.html')
          const info = await browser.tabs.create({
            active: !(parent && parent.folded),
            cookieStoreId: destCtx,
            index: dropIndex + i,
            openerTabId: dropParent < 0 ? undefined : dropParent,
            url: node.url ? node.url : groupPageUrl + `#${encodeURI(node.title)}`,
            windowId: state.windowId,
            pinned: pin,
          })
          oldNewMap[node.id] = info.id
          // Restore parentId
          if (state.tabsTree && nodes.length > 1 && nodes[0].id === nodes[1].parentId && !pin) {
            const tab = state.tabs.find(t => t.id === info.id)
            if (tab && oldNewMap[node.parentId]) tab.parentId = oldNewMap[node.parentId]
          }
          // Remove source tab (and update tabs tree)
          if (nodes[0].type === 'tab' && !event.ctrlKey) {
            await browser.tabs.remove(node.id)
          }
        }
        // Update tabs tree if there are no tabs was deleted
        if (nodes[0].type !== 'tab' || event.ctrlKey) {
          state.tabs = Utils.CalcTabsTreeLevels(state.tabs)
        }
      }
    }

    // Native event
    if (!nodes) {
      if (!event.dataTransfer) return
      for (let item of event.dataTransfer.items) {
        if (item.kind !== 'string') return

        if (item.type === 'text/uri-list') {
          item.getAsString(s => {
            if (!s.startsWith('http')) return
            if (destCtx) {
              browser.tabs.create({
                active: false,
                url: s,
                index: dropIndex,
                openerTabId: dropParent < 0 ? undefined : dropParent,
                cookieStoreId: destCtx,
                windowId: state.windowId,
              })
            } else {
              browser.tabs.create({ url: s, windowId: state.windowId })
            }
          })
        }
      }
    }

    dispatch('saveTabsTree')
  },

  /**
   * Flatten tabs tree
   *
   * TODO: to mutations
   */
  flattenTabs({ state, dispatch }, tabIds) {
    // Gather children
    let minLvlTab = { lvl: 999 }
    const toFlat = [...tabIds]
    const ttf = tabIds.map(id => state.tabs.find(t => t.id === id))
    for (let tab of state.tabs) {
      if (tab.hidden) continue
      if (toFlat.includes(tab.id) && tab.lvl < minLvlTab.lvl) minLvlTab = tab
      if (toFlat.includes(tab.parentId)) {
        if (!toFlat.includes(tab.id)) {
          toFlat.push(tab.id)
          ttf.push(tab)
        }
        if (tab.lvl < minLvlTab.lvl) minLvlTab = tab
      }
    }

    if (!minLvlTab.parentId) return
    for (let tab of ttf) {
      tab.lvl = minLvlTab.lvl
      tab.parentId = minLvlTab.parentId
    }

    state.tabs = Utils.CalcTabsTreeLevels(state.tabs)
    dispatch('saveTabsTree', 250)
  },

  /**
   * Group tabs
   */
  async groupTabs({ state, dispatch }, tabIds) {
    // Check permissions
    const permitted = await browser.permissions.contains({ origins: ['<all_urls>'] })
    if (!permitted) {
      const url = browser.runtime.getURL('permissions/all-urls.html')
      browser.tabs.create({ url })
      return
    }

    // Get tabs
    const tabs = []
    for (let t of state.tabs) {
      if (tabIds.includes(t.id) && t.url.indexOf('about:')) tabs.push(t)
      if (tabs.length === tabIds) break
    }

    if (!tabs.length) return
    if (tabs[0].lvl >= state.tabsTreeLimit) return

    // Find title for group tab
    const titles = tabs.map(t => t.title)
    let commonPart = Utils.CommonSubStr(titles)
    let isOk = commonPart[0] === commonPart[0].toUpperCase()
    let groupTitle = commonPart
      .replace(/^(\s|\.|_|-|—|\/|=|;|:)+/, ' ')
      .replace(/(\s|\.|_|-|—|\/|=|;|:)+$/, ' ')
      .trim()

    if (!isOk || groupTitle.length < 4) {
      const hosts = tabs.map(t => t.url.split('/')[2])
      groupTitle = Utils.CommonSubStr(hosts)
      if (groupTitle.startsWith('.')) groupTitle = groupTitle.slice(1)
      groupTitle = groupTitle.replace(/^www\./, '')
    }

    if (!isOk || groupTitle.length < 4) {
      groupTitle = 'Group ' + tabs[0].index
    }

    // Find index and create group tab
    const groupTab = await browser.tabs.create({
      active: !(parent && parent.folded),
      cookieStoreId: tabs[0].cookieStoreId,
      index: tabs[0].index,
      openerTabId: tabs[0].parentId < 0 ? undefined : tabs[0].parentId,
      url: browser.runtime.getURL('group/group.html') + `#${encodeURI(groupTitle)}`,
      windowId: state.windowId,
    })

    // Update parent of selected tabs
    tabs.forEach(t => (t.parentId = groupTab.id))
    state.tabs = Utils.CalcTabsTreeLevels(state.tabs)
    dispatch('saveTabsTree', 250)
  },

  /**
   * Get grouped tabs (for group page)
   */
  async getGroupInfo({ state }, groupTitle) {
    await Utils.Sleep(128)

    const groupTab = state.tabs.find(t => t.title === groupTitle)
    if (!groupTab) return {}

    const out = {
      id: groupTab.id,
      tabs: [],
    }

    const parents = [groupTab.id]
    for (let t of state.tabs) {
      if (parents.includes(t.parentId)) {
        if (t.isParent) parents.push(t.id)
        let screen
        if (!t.discarded) {
          screen = await browser.tabs.captureTab(t.id, { format: 'jpeg', quality: 90 })
        }
        out.tabs.push({
          id: t.id,
          title: t.title,
          url: t.url,
          screen,
        })
      }
    }

    return out
  },
}
