(() => {
  const APP_ID = '730';
  const CONTEXT_ID = '2';
  const HISTORY_PAGE_SIZE = 100;
  const HISTORY_MAX_PAGES = 50;
  const STORAGE_KEY = 'invHistoryOverlayCacheV1';
  const REQUEST_GAP_MS = 200;
  const RETRY_429_DELAY_MS = 60 * 1000;

  const state = {
    steamId: null,
    assetToHash: new Map(),
    lastBuyByHash: new Map(),
    lastSellByHash: new Map(),
    observer: null,
    loading: false,
    totalEvents: 0,
    latestRowKey: null,
    totalCount: null,
  };






  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }


function parsePriceValue(priceText) {
  if (!priceText) return null;

  const normalized = priceText
    .replace(/\s/g, '')
    .replace(/,--/g, ',00')
    .replace(/\.--/g, '.00')
    .replace(/--/g, '00')
    .replace(',', '.');

  const numMatch = normalized.match(/(\d+(?:\.\d+)?)/);
  if (!numMatch) return null;

  const value = Number.parseFloat(numMatch[1]);
  return Number.isFinite(value) ? value : null;
}




async function findSteamId64() {
  const fromPath = window.location.pathname.match(/\/profiles\/(\d{17})(?:\/|$)/)?.[1];
  if (fromPath) return fromPath;

  const vanity = window.location.pathname.match(/\/id\/([^/]+)(?:\/|$)/)?.[1];

  if (vanity) {
    const xmlUrl = `https://steamcommunity.com/id/${encodeURIComponent(vanity)}?xml=1`;
    const response = await fetch(xmlUrl, { credentials: 'include' });

    if (response.ok) {
      const text = await response.text();
      const steamId = text.match(/<steamID64>(\d{17})<\/steamID64>/)?.[1];
      if (steamId) return steamId;
    }
  }

  const profileLink =
    document.querySelector('a[href*="/profiles/"]')?.getAttribute('href') || '';

  return profileLink.match(/\/profiles\/(\d{17})(?:\/|$)/)?.[1] || null;
}

  function normalizeMarketHashName(name) {
    if (!name) return name;

    // Keep wear in the key. Removing (Factory New / Field-Tested / etc.)
    // mixes different skin conditions and causes wrong buy/sell overlays.
    return String(name)
      .replace(/\s+/g, ' ')
      .trim();
  }

  function setLastAction(store, key, entry) {
    if (!store || !key || store.has(key)) return;

    store.set(key, {
      priceText: entry.priceText || '--',
      priceValue: entry.priceValue,
      time: entry.dateText || null,
    });
  }

  function buildAssetNameMap(assetsData) {
    const map = new Map();
    if (!assetsData || typeof assetsData !== 'object') return map;

    Object.values(assetsData).forEach((appAssets) => {
      if (!appAssets || typeof appAssets !== 'object') return;
      Object.values(appAssets).forEach((contextAssets) => {
        if (!contextAssets || typeof contextAssets !== 'object') return;
        Object.values(contextAssets).forEach((asset) => {
          if (asset?.id && asset?.market_hash_name) {
            map.set(String(asset.id), asset.market_hash_name);
          }
        });
      });
    });

    return map;
  }


  function buildHistoryRowAssetIdMap(hovers) {
    const map = new Map();
    if (typeof hovers !== 'string' || !hovers) return map;

    const regex = /CreateItemHoverFromContainer\(\s*g_rgAssets\s*,\s*['"]history_row_(\d+)_(\d+)_(?:name|image)['"]\s*,\s*\d+\s*,\s*['"][^'"]+['"]\s*,\s*['"](\d+)['"]/g;
    let match;

    while ((match = regex.exec(hovers)) !== null) {
      const rowKey = `${match[1]}_${match[2]}`;
      const assetId = match[3];
      if (rowKey && assetId && !map.has(rowKey)) {
        map.set(rowKey, assetId);
      }
    }

    return map;
  }

  function extractListingIdFromActionLink(link) {
    if (typeof link !== 'string') return null;
    const match = link.match(/M(\d{6,})/);
    return match?.[1] || null;
  }

  function walkObjects(input, visitor) {
    if (!input) return;
    if (Array.isArray(input)) {
      input.forEach((value) => walkObjects(value, visitor));
      return;
    }

    if (typeof input !== 'object') return;
    visitor(input);
    Object.values(input).forEach((value) => walkObjects(value, visitor));
  }

  function buildListingIdHashMap(data) {
    const map = new Map();

    walkObjects(data?.assets, (node) => {
      if (!node || typeof node !== 'object') return;
      const hashName = node.market_hash_name || node.market_name || null;
      if (!hashName) return;

      const links = [];
      if (Array.isArray(node.actions)) {
        node.actions.forEach((action) => links.push(action?.link));
      }
      if (Array.isArray(node.market_actions)) {
        node.market_actions.forEach((action) => links.push(action?.link));
      }

      links.forEach((link) => {
        const listingId = extractListingIdFromActionLink(link);
        if (listingId && !map.has(listingId)) {
          map.set(listingId, hashName);
        }
      });
    });

    return map;
  }

  function parseHistoryRows(html, listingIdHashMap, rowAssetNameMap = new Map()) {
    if (!html) return [];
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const rows = Array.from(doc.querySelectorAll('.market_recent_listing_row'));

    return rows
      .map((row) => {
        const nameEl = row.querySelector('.market_listing_item_name');
        const combinedDates = Array.from(row.querySelectorAll('.market_listing_listed_date_combined'));
        const actionText = combinedDates.map((el) => el.textContent?.trim() || '').find(Boolean) || '';
        const gainOrLossText = row.querySelector('.market_listing_gainorloss')?.textContent?.trim() || '';
        const action = detectHistoryAction(actionText, gainOrLossText);
        const dateText =
          combinedDates
            .map((el) => el.textContent?.trim() || '')
            .map((text) =>
				  text
					.replace(/^(Purchased|Sold|Bought|Buy|Sell|Куплено|Продано|Придбано|Придбання|Продаж|Покупка|Купівля)\s*:?\s*/i, '')
					.trim()
				)
            .find(Boolean) ||
          row.querySelector('.market_listing_listed_date')?.textContent?.trim() ||
          null;
        const rowId = row.getAttribute('id') || '';
        const idParts = rowId.split('_');
        const listingId = idParts.length >= 3 ? idParts[idParts.length - 2] : null;
        const purchaseId = idParts.length >= 3 ? idParts[idParts.length - 1] : null;
        const rowKey = listingId && purchaseId ? `${listingId}_${purchaseId}` : null;
        const exactName = rowKey ? rowAssetNameMap.get(rowKey) : null;
        const mappedName = listingId ? listingIdHashMap.get(listingId) : null;
        const name = exactName || mappedName || nameEl?.textContent?.trim() || '';
        const priceText = extractPriceTextFromHistoryRow(row);

        if (!name) return null;
        return { marketHashName: name, action, priceText, priceValue: parsePriceValue(priceText), dateText, rowKey };
      })
      .filter(Boolean);
  }

function detectHistoryAction(actionText, gainOrLossText) {
  const text = `${actionText || ''} ${gainOrLossText || ''}`.toLowerCase();

  if (gainOrLossText === '-') return 'SELL';
  if (gainOrLossText === '+') return 'BUY';

  if (/(sold|sell|sale|продано|продаж|продажа|продано:|продано\s*:)/i.test(text)) {
    return 'SELL';
  }

  if (/(purchased|bought|buy|куплено|придбано|придбання|покупка|купівля|куплено\s*:|придбано\s*:)/i.test(text)) {
    return 'BUY';
  }

  return null;
}
  function extractPriceTextFromHistoryRow(row) {
    const priceNode = row.querySelector('.market_listing_price');
    if (!priceNode) return null;

    const raw = priceNode.textContent?.replace(/\s+/g, ' ').trim() || '';
    if (!raw) return null;

    const moneyMatches = raw.match(
      /((?:[A-Z]{2,4}\$|[€$£¥₴₽])\s*\d[\d\s.,\-–—]*)|(\d[\d\s.,\-–—]*\s*(?:[A-Z]{2,4}\$|[€$£¥₴₽]))/g
    );

    if (Array.isArray(moneyMatches) && moneyMatches.length > 0) {
      return moneyMatches[moneyMatches.length - 1].replace(/\s+/g, ' ').trim();
    }

    return null;
  }

  function normalizePriceText(value) {
    if (typeof value !== 'string') return null;
    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized || null;
  }

  function extractPriceTextFromRecord(record) {
    if (!record || typeof record !== 'object') return null;

    const candidates = [
      record.price_formatted,
      record.formatted_price,
      record.formatted_price_with_fee,
      record.price_with_fee_formatted,
      record.total_price_formatted,
      record.price_text,
      record.price,
      record.purchase_price,
      record.buyer_price,
      record.amount_text,
      record.received_amount_text,
      record.paid_amount_text,
      record.converted_price,
      record.converted_currency,
      record?.asset?.amount,
      record?.asset?.price,
    ];

    for (const candidate of candidates) {
      const normalized = normalizePriceText(candidate);
      if (!normalized) continue;

      const looksLikeMoney = /(?:[A-Z]{2,4}\$|[€$£¥₴₽])/.test(normalized) || /\d+[.,]\d+/.test(normalized);
      if (looksLikeMoney) return normalized;
    }

    return null;
  }

  function getRecordAssetId(record, assetNameMap) {
    if (!record || typeof record !== 'object') return null;

    const directCandidates = [
      record?.asset?.id,
      record?.asset?.assetid,
      record?.asset?.asset_id,
      record?.assetid,
      record?.asset_id,
      record?.unowned_id,
    ];

    for (const candidate of directCandidates) {
      if (candidate == null) continue;
      const value = String(candidate);
      if (/^\d+$/.test(value) && assetNameMap.has(value)) return value;
    }

    const seen = new Set();
    const stack = [record];
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);

      if (Array.isArray(node)) {
        node.forEach((value) => stack.push(value));
        continue;
      }

      for (const [key, value] of Object.entries(node)) {
        if (value && typeof value === 'object') {
          stack.push(value);
          continue;
        }

        if (value == null) continue;
        const normalizedKey = String(key).toLowerCase();
        if (!/(^id$|asset|unowned)/.test(normalizedKey)) continue;

        const candidate = String(value);
        if (/^\d+$/.test(candidate) && assetNameMap.has(candidate)) {
          return candidate;
        }
      }
    }

    return null;
  }

  function extractHistoryEntries(data) {
    const assetNameMap = buildAssetNameMap(data?.assets);
    const rowAssetIdMap = buildHistoryRowAssetIdMap(data?.hovers || '');
    const rowAssetNameMap = new Map();
    rowAssetIdMap.forEach((assetId, rowKey) => {
      const name = assetNameMap.get(assetId);
      if (name) rowAssetNameMap.set(rowKey, name);
    });

    const listingIdHashMap = buildListingIdHashMap(data);
    const events = Array.isArray(data?.events) ? data.events : [];
    const listings = data?.listings || {};
    const purchases = data?.purchases || {};
    const rowEntries = parseHistoryRows(data?.results_html || '', listingIdHashMap, rowAssetNameMap);
    const byRow = new Map(rowEntries.filter((entry) => entry.rowKey).map((entry) => [entry.rowKey, entry]));
    const byNameAction = new Map();
    rowEntries.forEach((entry) => {
      const key = `${entry.marketHashName}::${entry.action}`;
      if (!byNameAction.has(key)) byNameAction.set(key, entry);
    });

    const fromEvents = events
      .map((event) => {
        const purchaseId = event?.purchaseid ? String(event.purchaseid) : null;
        const listingId = event?.listingid ? String(event.listingid) : null;
        const action = event?.event_type === 4 ? 'BUY' : event?.event_type === 3 ? 'SELL' : null;
        if (!action || !listingId || !purchaseId) return null;

        const rowKey = `${listingId}_${purchaseId}`;
        const rowMeta = byRow.get(rowKey);

        const recordCandidates = [
          purchases[rowKey],
          purchases[purchaseId],
          purchases[listingId],
          listings[listingId],
          listings[rowKey],
        ].filter(Boolean);

        const assetId = [event, ...recordCandidates].map((record) => getRecordAssetId(record, assetNameMap)).find(Boolean);
        const priceRecord = recordCandidates.find((record) => extractPriceTextFromRecord(record)) || recordCandidates[0] || null;

        const marketHashName =
          (assetId ? assetNameMap.get(assetId) : null) ||
          rowMeta?.marketHashName ||
          listingIdHashMap.get(listingId) ||
          null;
        if (!marketHashName) return null;

        const fallbackRow = byNameAction.get(`${marketHashName}::${action}`);
        const priceText = rowMeta?.priceText || fallbackRow?.priceText || extractPriceTextFromRecord(priceRecord) || null;
        return {
          marketHashName,
          action,
          priceText,
          priceValue: rowMeta?.priceValue || parsePriceValue(priceText),
          dateText: rowMeta?.dateText || null,
          rowKey,
        };
      })
      .filter(Boolean);
    return fromEvents.length > 0 ? fromEvents : rowEntries;
  }

  function saveCache() {
    if (!state.steamId) return;
    const payload = {
      steamId: state.steamId,
      latestRowKey: state.latestRowKey,
      totalCount: state.totalCount,
      totalEvents: state.totalEvents,
      savedAt: Date.now(),
      lastBuyByHash: Array.from(state.lastBuyByHash.entries()),
      lastSellByHash: Array.from(state.lastSellByHash.entries()),
    };

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (error) {
    }
  }

  function loadCache() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.steamId !== state.steamId) return false;

      state.latestRowKey = parsed.latestRowKey || null;
      state.totalCount = Number.isFinite(parsed.totalCount) ? parsed.totalCount : null;
      state.totalEvents = Number.isFinite(parsed.totalEvents) ? parsed.totalEvents : 0;
      state.lastBuyByHash = new Map(Array.isArray(parsed.lastBuyByHash) ? parsed.lastBuyByHash : []);
      state.lastSellByHash = new Map(Array.isArray(parsed.lastSellByHash) ? parsed.lastSellByHash : []);
      return true;
    } catch (error) {
      return false;
    }
  }

  function clearCacheAndOverlay() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {}

    state.latestRowKey = null;
    state.totalCount = null;
    state.totalEvents = 0;
    state.lastBuyByHash.clear();
    state.lastSellByHash.clear();

    document.querySelectorAll('.itemHolder .item[id^="730_2_"]').forEach((tile) => {
      tile.classList.remove('inv-history-buy', 'inv-history-sell');
      tile.querySelector('.history-overlay')?.remove();
      tile.dataset.historyApplied = '0';
    });
  }

  async function fetchInventoryMap(steamId) {
    const url = `https://steamcommunity.com/inventory/${steamId}/${APP_ID}/${CONTEXT_ID}?l=english&count=1000&preserve_bbcode=1&raw_asset_properties=1`;
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) throw new Error(`Inventory HTTP ${response.status}`);

    const data = await response.json();
    const descMap = new Map();
    (data.descriptions || []).forEach((desc) => {
      if (!desc?.classid || !desc?.instanceid || !desc?.market_hash_name) return;
      descMap.set(`${desc.classid}_${desc.instanceid}`, desc.market_hash_name);
    });

    state.assetToHash.clear();
    (data.assets || []).forEach((asset) => {
      const key = `${asset.classid}_${asset.instanceid}`;
      const hash = descMap.get(key);
      if (asset?.assetid && hash) state.assetToHash.set(String(asset.assetid), hash);
    });
    console.log('[INV] assetToHash size:', state.assetToHash.size);
  }

  async function fetchHistoryWithLimits(limitCount, onlyNew = false) {
    const collected = [];
    let start = 0;
    let page = 0;
    const targetCount = Math.max(1, Number.parseInt(limitCount, 10) || 100);

    let reachedKnownRow = false;

    while (page < HISTORY_MAX_PAGES) {
      const params = new URLSearchParams({
        query: '',
        start: String(start),
        count: String(HISTORY_PAGE_SIZE),
        l: 'english',
      });

      let response;
      while (true) {
        response = await fetch(`https://steamcommunity.com/market/myhistory/render/?${params.toString()}`, {
          credentials: 'include',
          headers: { Accept: 'application/json' },
        });

        if (response.status === 429) {
          await delay(RETRY_429_DELAY_MS);
          continue;
        }

        break;
      }

      if (!response.ok) throw new Error(`History HTTP ${response.status}`);
      const data = await response.json();
      const entries = extractHistoryEntries(data);
      console.log('[INV] fetched entries:', entries.length, entries.slice(0, 5));
      state.totalCount = Number(data?.total_count || state.totalCount || 0) || state.totalCount;
      if (!entries.length) break;

      let pageEntries = entries;
      if (onlyNew && state.latestRowKey) {
        const idx = entries.findIndex((entry) => entry.rowKey === state.latestRowKey);
        if (idx >= 0) {
          reachedKnownRow = true;
          pageEntries = entries.slice(0, idx);
        }
      }

      collected.push(...pageEntries);

      if (onlyNew && reachedKnownRow) {
        break;
      }

      if (targetCount && collected.length >= targetCount) {
        return collected.slice(0, targetCount);
      }
      const totalCount = Number(data?.total_count || 0);
      await delay(REQUEST_GAP_MS);
      start += HISTORY_PAGE_SIZE;
      page += 1;
      if (!totalCount || start >= totalCount) break;
    }

    return collected;
  }

  function buildLastActionMaps(entries, preserveExisting = false) {
    const existingBuy = preserveExisting ? new Map(state.lastBuyByHash) : new Map();
    const existingSell = preserveExisting ? new Map(state.lastSellByHash) : new Map();
    const previousLatestRowKey = state.latestRowKey;
    const newestRowKey = entries.find((entry) => entry?.rowKey)?.rowKey || null;

    state.lastBuyByHash.clear();
    state.lastSellByHash.clear();

    entries.forEach((entry) => {
      const store = entry.action === 'BUY' ? state.lastBuyByHash : entry.action === 'SELL' ? state.lastSellByHash : null;
      if (!store || !entry.marketHashName) return;

      const exactName = entry.marketHashName;
      setLastAction(store, exactName, entry);

    });

    if (newestRowKey) {
      state.latestRowKey = newestRowKey;
    } else {
      state.latestRowKey = previousLatestRowKey || null;
    }

    if (preserveExisting) {
      existingBuy.forEach((value, key) => {
        if (!state.lastBuyByHash.has(key)) state.lastBuyByHash.set(key, value);
      });
      existingSell.forEach((value, key) => {
        if (!state.lastSellByHash.has(key)) state.lastSellByHash.set(key, value);
      });
      state.totalEvents += entries.length;
    } else {
      state.totalEvents = entries.length;
    }
	console.log('[INV] BUY map size:', state.lastBuyByHash.size);
	console.log('[INV] SELL map size:', state.lastSellByHash.size);
  }

  function ensureTileOverlay(tile) {
    let overlay = tile.querySelector('.history-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'history-overlay';
      tile.appendChild(overlay);
    }
    return overlay;
  }

  function applyOverlay(tile) {
    if (!tile?.id) return false;

    const assetId = tile.id.split('_').pop();
    const rawHash = state.assetToHash.get(assetId);

    if (!rawHash) {
      console.log('[INV] no hash for assetId:', assetId);
      return false;
    }

    const exactHash = rawHash;

    const buy = state.lastBuyByHash.get(exactHash);
    const sell = state.lastSellByHash.get(exactHash);

    console.log('[INV] tile:', exactHash, 'buy:', buy, 'sell:', sell);

    tile.classList.remove('inv-history-buy', 'inv-history-sell');

    if (!buy && !sell) {
      const prev = tile.querySelector('.history-overlay');
      if (prev) prev.remove();
      tile.dataset.historyApplied = '0';
      return false;
    }

    if (sell) {
      tile.classList.add('inv-history-sell');
    } else if (buy) {
      tile.classList.add('inv-history-buy');
    }

    const overlay = ensureTileOverlay(tile);
    overlay.innerHTML = '';

    if (sell) {
      const sellEl = document.createElement('div');
      sellEl.className = 'history-price sell';
      sellEl.textContent = `S: ${sell.priceText}`;
      overlay.appendChild(sellEl);
    }

    if (buy) {
      const buyEl = document.createElement('div');
      buyEl.className = 'history-price buy';
      buyEl.textContent = `B: ${buy.priceText}`;
      overlay.appendChild(buyEl);
    }

    tile.dataset.historyApplied = '1';
    return true;
  }

  function applyOverlayToAllVisibleTiles() {
    const tiles = document.querySelectorAll('.itemHolder .item[id^="730_2_"]');
    let matched = 0;
    tiles.forEach((tile) => {
      if (applyOverlay(tile)) matched += 1;
    });
    return { total: tiles.length, matched };
  }

  function startObserver() {
    if (state.observer) return;
    const target = document.querySelector('#tabcontent_inventory') || document.body;
    if (!target) return;

    state.observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (!(node instanceof Element)) return;
          if (node.matches?.('.itemHolder .item[id^="730_2_"]')) {
            applyOverlay(node);
          }
          node.querySelectorAll?.('.itemHolder .item[id^="730_2_"]').forEach((tile) => applyOverlay(tile));
        });
      }
    });

    state.observer.observe(target, { childList: true, subtree: true });
  }

  function createControls() {
    const logos = document.getElementById('inventory_logos');
    if (!logos || document.getElementById('invHistoryControls')) return null;

    const bar = document.createElement('div');
    bar.id = 'invHistoryControls';
    bar.className = 'inv-history-controls';
    bar.innerHTML = `
      <button type="button" id="invHistorySync">Sync History</button>
      <button type="button" id="invHistoryClear">Clear Sync</button>
      <label>Count:</label>
      <input id="invHistoryCount" class="small-input" type="number" min="1" max="5000" value="500">
      <label><input type="checkbox" id="invHistoryOnlyNew"> Only new</label>
      <span class="status" id="invHistoryStatus">Idle</span>
    `;

	const wrapper = document.createElement('div');
	wrapper.id = 'invHistoryControlsWrapper';
	wrapper.appendChild(bar);
	
	if (logos && logos.parentNode) {
	  logos.parentNode.insertBefore(wrapper, logos);
	}

    return {
      syncBtn: bar.querySelector('#invHistorySync'),
      clearBtn: bar.querySelector('#invHistoryClear'),
      countInput: bar.querySelector('#invHistoryCount'),
      onlyNewInput: bar.querySelector('#invHistoryOnlyNew'),
      status: bar.querySelector('#invHistoryStatus'),
    };
  }

  function waitForInventoryHeader(timeoutMs = 15000) {
    return new Promise((resolve) => {
      const existing = document.getElementById('inventory_logos');
      if (existing) {
        resolve(true);
        return;
      }

      const observer = new MutationObserver(() => {
        if (document.getElementById('inventory_logos')) {
          observer.disconnect();
          resolve(true);
        }
      });

      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => {
        observer.disconnect();
        resolve(false);
      }, timeoutMs);
    });
  }

  async function init() {
    const isInventory = /\/inventory/.test(window.location.pathname);
    if (!isInventory) return;

    const mounted = await waitForInventoryHeader();
    if (!mounted) return;

    state.steamId = await findSteamId64();
    console.log('[INV] SteamID:', state.steamId);
    const ui = createControls();
    if (!ui) return;

    const loadedFromCache = loadCache();
    if (loadedFromCache) {
      applyOverlayToAllVisibleTiles();
      startObserver();
      ui.status.textContent = 'Cache loaded';
    }

    ui.clearBtn.addEventListener('click', () => {
      clearCacheAndOverlay();
      ui.status.textContent = 'Sync cache cleared';
    });

    ui.syncBtn.addEventListener('click', async () => {
      if (state.loading) return;
      state.loading = true;
      ui.syncBtn.disabled = true;

      try {
        if (!state.steamId) {
          throw new Error('SteamID64 not found in URL/page');
        }

        const limitCount = ui.countInput.value;
        const onlyNew = !!ui.onlyNewInput.checked;

        await fetchInventoryMap(state.steamId);
        const entries = await fetchHistoryWithLimits(limitCount, onlyNew);
        buildLastActionMaps(entries, onlyNew);
        saveCache();

        applyOverlayToAllVisibleTiles();
        startObserver();
        ui.status.textContent = 'Synced';
      } catch (error) {
        ui.status.textContent = `Error: ${error.message}`;
      } finally {
        state.loading = false;
        ui.syncBtn.disabled = false;
      }
    });
  }

  init();
})();
