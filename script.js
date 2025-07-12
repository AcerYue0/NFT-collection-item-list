// 確保整個網頁文件 (DOM) 都載入完成後，才開始執行我們的 JavaScript 程式碼。
// 這是非常重要的最佳實踐，可以避免試圖操作還不存在的 HTML 元素。
document.addEventListener('DOMContentLoaded', () => {

    // --- 設定 ---
    const API_URL = 'https://marketplace-core-ll9s.onrender.com/api/marketplace/getList';
    const UPDATE_INTERVAL_MS = 1 * 60 * 1000; // 1 分鐘

    // MQTT 設定 (請根據您的環境修改)
    const MQTT_BROKER_URL = 'ws://127.0.0.1:9001'; // 使用 WebSocket (ws:// 或 wss://)
    const MQTT_TOPIC = 'marketplace/item/update';

    let DONATE_URL = 'https://maplestory-n.com/?toAddress=0xcece13060EC558d1F3c39945a7283FAA1B002777&amount={}';
    // --- 全域狀態 ---
    // 儲存從 API 獲取的原始資料陣列，這是唯一的資料來源 (Single Source of Truth)
    let allApiData = [];
    // 儲存用於比較價格變動的舊資料快照
    let previousDataSnapshot = {};
    // 儲存使用者標記為已持有的物品 (使用 Set 結構以獲得高效的查找性能)
    let ownedItems = new Set(JSON.parse(localStorage.getItem('ownedItems') || '[]'));
    // 新增：儲存要排除的套裝物品列表
    let setItemList = new Set();
    // 新增：儲存所有物品的 ID 映射
    let itemIdMap = new Map();

    // 儲存當前的篩選條件
    let currentFilters = localStorage.getItem('currentFilters') ? JSON.parse(localStorage.getItem('currentFilters')) :
    {
        itemName: '',
        priceMin: null,
        priceMax: null,
        collectedStatus: 'all', // 'all', 'collected', 'uncollected'
        excludeSetItems: false // 新增：是否排除套裝物品的狀態
    };
    // 儲存當前的排序條件 (預設按更新時間降序)
    let currentSort = localStorage.getItem('currentSort') ? JSON.parse(localStorage.getItem('currentSort')) :
    {
        by: 'price',
        order: 'asc'
    };

    // --- DOM 元素選取 ---
    // 將所有需要操作的 HTML 元素在程式碼開頭一次性選取好，方便管理。
    const table = document.getElementById('item-table');
    const tableBody = document.getElementById('item-table-body');
    const loadingIndicator = document.getElementById('loading-indicator');
    const errorMessage = document.getElementById('error-message');
    const lastUpdatedText = document.getElementById('last-updated-text');

    // Filter/Sort Popover Elements
    const filterSortToggle = document.getElementById('filter-sort-toggle');
    const filterSortPopover = document.getElementById('filter-sort-popover');
    const closePopoverButton = document.getElementById('close-popover');
    const itemNameFilterInput = document.getElementById('item-name-filter');
    const priceMinFilterInput = document.getElementById('price-min-filter');
    const priceMaxFilterInput = document.getElementById('price-max-filter');
    const sortBySelect = document.getElementById('sort-by');
    const collectedStatusFilterSelect = document.getElementById('collected-status-filter');
    // 新增：選取排除套裝的 checkbox
    const excludeSetItemsCheckbox = document.getElementById('exclude-set-items');
    const applyFiltersSortButton = document.getElementById('apply-filters-sort');
    const resetFiltersSortButton = document.getElementById('reset-filters-sort');

    // Donate Popover Elements
    const donateButton = document.getElementById('donate');
    const donatePopover = document.getElementById('donate-popover');
    const closeDonatePopoverButton = document.getElementById('close-donate-popover');
    const donateAmountInput = document.getElementById('donate-amount');
    const confirmDonationButton = document.getElementById('confirm-donation');

    // Overlay Element
    const popoverOverlay = document.getElementById('popover-overlay');

    // --- 函式定義 ---
    // 將所有功能性函式定義在這裡。因為它們都在 DOMContentLoaded 內部，
    // 所以它們可以存取上面定義的所有變數。

    /**
     * 新增：抓取靜態資料，例如要排除的物品列表和物品ID
     */
    async function fetchStaticData() {
        try {
            const response = await fetch('set_item_list.json');
            if (!response.ok) {
                throw new Error(`Could not fetch set_item_list.json, status: ${response.status}`);
            }
            const itemData = await response.json();

            // 處理 "set" 類別的物品，加入排除列表
            const setItemNames = Object.keys(itemData.set || {});
            setItemList = new Set(setItemNames);
            console.log(`${setItemList.size} set items loaded into the exclusion list.`);

            // 建立 itemName -> itemId 的映射
            itemIdMap.clear(); // 清空舊的映射
            const allItems = { ...(itemData.normal || {}), ...(itemData.set || {}) };
            for (const [name, id] of Object.entries(allItems)) {
                itemIdMap.set(name, id);
            }
            console.log(`${itemIdMap.size} total items loaded into the ID map.`);
        } catch (error) {
            console.error('Error fetching static data (item list):', error);
            // 即使列表載入失敗，應用程式仍可繼續運行
        }
    }
    // 定義統一的時間格式選項，強制使用 24 小時制
    const dateTimeFormatOptions = {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    };

    /**
     * 關閉所有彈出視窗和遮罩
     */
    function closeAllPopovers() {
        filterSortPopover.classList.add('hidden');
        donatePopover.classList.add('hidden');
        popoverOverlay.classList.add('hidden');
    }

    /**
     * 切換篩選/排序彈出視窗的顯示狀態
     */
    function toggleFilterSortPopover() {
        const isHidden = filterSortPopover.classList.contains('hidden');
        closeAllPopovers(); // 統一先關閉所有視窗
        if (isHidden) { // 如果原本是關的，就把它跟遮罩打開
            filterSortPopover.classList.remove('hidden');
            popoverOverlay.classList.remove('hidden');
            itemNameFilterInput.focus();
        }
    }

    /**
     * 將 UTC timestamp (秒或毫秒) 轉換為本地時間的可讀字串。
     * 會自動偵測 timestamp 的單位。
     */
    function formatTime(utcTimestamp) {
        if (!utcTimestamp || typeof utcTimestamp !== 'number') return 'N/A';

        // 透過數值大小判斷 timestamp 是秒還是毫秒
        // 當前時間的秒級 timestamp 約為 10 位數，毫秒級為 13 位數
        const timestampInMs = utcTimestamp > 10 ** 11 ? utcTimestamp : utcTimestamp * 1000;
        return new Date(timestampInMs).toLocaleString('default', dateTimeFormatOptions);
    }

    /**
     * 根據資料陣列渲染表格。此函式會清空並重建表格內容。
     * @param {Array<object>} items - 經過篩選和排序後的項目陣列
     */
    function renderTable(items) {
        // 清空現有表格內容，這是最關鍵的一步，確保排序能正確顯示
        tableBody.innerHTML = '';

        if (items.length === 0) {
            // 注意：欄位數已從 4 變為 5
            tableBody.innerHTML = '<tr><td colspan="5">No items match the criteria.</td></tr>';
            return;
        }

        const fragment = document.createDocumentFragment();

        items.forEach(item => {
            const row = document.createElement('tr');

            // 處理價格變動的視覺提示
            const oldItem = previousDataSnapshot[item.itemName];
            if (oldItem && oldItem.price !== item.price) {
                row.classList.add('row-updated');
                row.addEventListener('animationend', () => row.classList.remove('row-updated'), { once: true });
            }

            // 標記無法購買的項目
            if (item.price == null || item.price === -1) {
                row.classList.add('unavailable');
            }

            // --- 使用 createElement 重構，方便綁定事件 ---

            // 1. 圖片欄
            const imgCell = document.createElement('td');
            imgCell.className = 'image-cell';
            const encodedItemName = item.itemName.replace(/ /g, '+');
            const linkUrl = `https://msu.io/marketplace/nft?keyword=${encodedItemName}&price=0%2C10000000000&level=0%2C250&categories=0&potential=0%2C4&bonusPotential=0%2C4&starforce=0%2C25&sort=ExploreSorting_LOWEST_PRICE`;
            
            // --- 圖片 URL 生成邏輯修改 ---
            let imageContent;
            const itemId = itemIdMap.get(item.itemName); // 從 Map 中獲取 ID

            const itemIconUrl = `https://api-static.msu.io/itemimages/icon/${itemId}.png`;
            imageContent = `<img src="${itemIconUrl}" alt="${item.itemName}" class="item-image" onerror="this.style.display='none'; this.nextSibling.style.display='inline';"><span class="no-image" style="display:none;">No Image</span>`;
            // 增加超連結，並在新分頁開啟
            imgCell.innerHTML = `<a href="${linkUrl}" target="_blank" rel="noopener noreferrer">${imageContent}</a>`;
            // 2. 名稱欄
            const nameCell = document.createElement('td');
            nameCell.textContent = item.itemName;

            // 3. 價格欄
            const priceCell = document.createElement('td');
            priceCell.textContent = (item.price == null || item.price === -1) ? 'N/A' : item.price.toLocaleString();

            // 4. 更新時間欄
            const timeCell = document.createElement('td');
            timeCell.className = 'time-cell';
            timeCell.textContent = formatTime(item.updateTimeUTC);

            // 5. 新增：持有狀態 checkbox 欄
            const ownedCell = document.createElement('td');
            const ownedCheckbox = document.createElement('input');
            ownedCheckbox.type = 'checkbox';
            ownedCheckbox.className = 'owned-checkbox';
            ownedCheckbox.dataset.itemName = item.itemName; // 將物品名稱存在 data-* 屬性中
            ownedCheckbox.checked = ownedItems.has(item.itemName); // 根據 Set 決定是否勾選
            ownedCheckbox.addEventListener('change', handleOwnedCheckboxChange); // 綁定事件
            ownedCell.appendChild(ownedCheckbox);

            row.append(ownedCell, imgCell, nameCell, priceCell, timeCell);
            fragment.appendChild(row);
        });

        tableBody.appendChild(fragment);
    }

    /**
     * 統一處理資料的篩選、排序和渲染
     */
    function processAndRender() {
        let itemsToDisplay = [...allApiData];

        itemsToDisplay = itemsToDisplay.filter(item => {
            const nameMatch = !currentFilters.itemName || item.itemName.toLowerCase().includes(currentFilters.itemName.toLowerCase());
            
            // 價格是否為 N/A (null, undefined, or -1)，統一處理
            const isPriceNA = item.price == null || item.price === -1;
            const minPriceMatch = currentFilters.priceMin === null || isPriceNA || item.price >= currentFilters.priceMin;
            const maxPriceMatch = currentFilters.priceMax === null || isPriceNA || item.price <= currentFilters.priceMax;
            // 新的篩選邏輯：根據 collectedStatus 決定是否顯示
            const collectedStatus = currentFilters.collectedStatus;
            const isOwned = ownedItems.has(item.itemName);
            let collectedStatusMatch = true; // 預設為 true (對應 'all')
            if (collectedStatus === 'collected') {
                collectedStatusMatch = isOwned;
            } else if (collectedStatus === 'uncollected') {
                collectedStatusMatch = !isOwned;
            }

            // 新增：排除套裝物品的篩選邏輯
            // 如果 "excludeSetItems" 為 true，則過濾掉在 setItemList 中的物品
            const excludeSetItemsMatch = !currentFilters.excludeSetItems || !setItemList.has(item.itemName);

            return nameMatch && minPriceMatch && maxPriceMatch && collectedStatusMatch && excludeSetItemsMatch;
        });

        itemsToDisplay.sort((a, b) => {
            let valA = a[currentSort.by];
            let valB = b[currentSort.by];

            if (currentSort.by === 'price') {
                const isAsc = currentSort.order === 'asc';
                // N/A 項目永遠排在最後
                const naValue = isAsc ? Infinity : -Infinity;
                valA = (valA == null || valA === -1) ? naValue : valA;
                valB = (valB == null || valB === -1) ? naValue : valB;
            }

            if (valA < valB) return currentSort.order === 'asc' ? -1 : 1;
            if (valA > valB) return currentSort.order === 'asc' ? 1 : -1;
            return 0;
        });

        renderTable(itemsToDisplay);
    }

    /**
     * 處理「持有」checkbox 的點擊事件
     * @param {Event} event
     */
    function handleOwnedCheckboxChange(event) {
        const checkbox = event.target;
        const itemName = checkbox.dataset.itemName;

        if (checkbox.checked) {
            ownedItems.add(itemName);
        } else {
            ownedItems.delete(itemName);
        }

        // 將更新後的 Set 轉為陣列並存入 localStorage
        localStorage.setItem('ownedItems', JSON.stringify(Array.from(ownedItems)));

        // 如果篩選器不是 "Show all"，則立即重新渲染以符合篩選條件
        if (currentFilters.collectedStatus !== 'all') {
            processAndRender();
        }
    }

    /**
     * 處理篩選和排序的應用
     */
    function handleFilterSort() {
        currentFilters.itemName = itemNameFilterInput.value.trim();
        currentFilters.priceMin = priceMinFilterInput.value ? parseFloat(priceMinFilterInput.value) : null;
        currentFilters.priceMax = priceMaxFilterInput.value ? parseFloat(priceMaxFilterInput.value) : null;
        currentFilters.collectedStatus = collectedStatusFilterSelect.value;
        // 新增：讀取排除套裝 checkbox 的狀態
        currentFilters.excludeSetItems = excludeSetItemsCheckbox.checked;

        currentSort.by = sortBySelect.value;
        currentSort.order = document.querySelector('input[name="sort-order"]:checked').value;
        localStorage.setItem('currentFilters', JSON.stringify(currentFilters));
        localStorage.setItem('currentSort', JSON.stringify(currentSort));

        processAndRender();
        toggleFilterSortPopover();
    }

    /**
     * 重設所有篩選和排序條件
     */
    function resetFilterSort() {
        itemNameFilterInput.value = '';
        priceMinFilterInput.value = '';
        priceMaxFilterInput.value = '';
        sortBySelect.value = 'updateTimeUTC';
        collectedStatusFilterSelect.value = 'all';
        // 新增：重設排除套裝 checkbox
        excludeSetItemsCheckbox.checked = false;
        document.querySelector('input[name="sort-order"][value="desc"]').checked = true;

        currentFilters = { itemName: '', priceMin: null, priceMax: null, collectedStatus: 'all', excludeSetItems: false };
        currentSort = { by: 'updateTimeUTC', order: 'desc' };

        // 重設後也應儲存狀態
        localStorage.setItem('currentFilters', JSON.stringify(currentFilters));
        localStorage.setItem('currentSort', JSON.stringify(currentSort));

        processAndRender();
        toggleFilterSortPopover();
    }

    /**
     * 根據儲存的狀態，初始化篩選/排序表單的UI
     */
    function updateFilterSortUI() {
        itemNameFilterInput.value = currentFilters.itemName;
        priceMinFilterInput.value = currentFilters.priceMin;
        priceMaxFilterInput.value = currentFilters.priceMax;
        collectedStatusFilterSelect.value = currentFilters.collectedStatus || 'all';
        // 新增：根據儲存的狀態更新 checkbox
        excludeSetItemsCheckbox.checked = currentFilters.excludeSetItems || false;
        sortBySelect.value = currentSort.by;
        document.querySelector(`input[name="sort-order"][value="${currentSort.order}"]`).checked = true;
    }

    /**
     * 主要功能：抓取並顯示道具資料
     */
    async function fetchAndDisplayItems() {
        const isFirstLoad = allApiData.length === 0;
        lastUpdatedText.textContent = 'Update in progress...';

        if (isFirstLoad) {
            loadingIndicator.classList.remove('hidden');
            table.classList.add('hidden');
        }
        errorMessage.classList.add('hidden');

        try {
            const response = await fetch(API_URL, {
                method: "GET",
                credentials: "include"
            });
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const newDataObject = await response.json();

            previousDataSnapshot = allApiData.reduce((acc, item) => {
                acc[item.itemName] = item;
                return acc;
            }, {});

            allApiData = Object.entries(newDataObject).map(([itemName, details]) => ({
                itemName,
                ...details
            }));

            if (isFirstLoad && allApiData.length === 0) {
                loadingIndicator.innerText = 'No data available.';
                lastUpdatedText.textContent = 'No data';
                return;
            }

            processAndRender();

            if (isFirstLoad) {
                loadingIndicator.classList.add('hidden');
                table.classList.remove('hidden');
            }
            lastUpdatedText.textContent = `Final update: ${new Date().toLocaleString('default', dateTimeFormatOptions)}`;

        } catch (error) {
            console.error('Error fetching data:', error);
            errorMessage.classList.remove('hidden');
            if (isFirstLoad) loadingIndicator.classList.add('hidden');
            lastUpdatedText.textContent = 'Update failed.';
        }
    }

    /**
     * 處理從 MQTT 收到的單一項目更新
     * @param {string} messageString - 從 MQTT 收到的原始訊息字串
     */
    function handleMqttUpdate(messageString) {
        try {
            // 假設收到的訊息是單一項目的 JSON 物件
            const itemUpdate = JSON.parse(messageString);

            if (!itemUpdate || !itemUpdate.itemName) {
                console.warn('Received invalid MQTT message:', itemUpdate);
                return;
            }

            const existingItemIndex = allApiData.findIndex(i => i.itemName === itemUpdate.itemName);

            if (existingItemIndex !== -1) {
                // 如果項目已存在，更新它
                // 使用 Object.assign 保留可能存在於舊物件但新訊息沒有的屬性
                allApiData[existingItemIndex] = { ...allApiData[existingItemIndex], ...itemUpdate };
            } else {
                // 如果是新項目，將其加入陣列
                allApiData.push(itemUpdate);
            }

            // 重新渲染表格以顯示更新
            processAndRender();
            lastUpdatedText.textContent = `Real-time update: ${new Date().toLocaleString('default', dateTimeFormatOptions)}`;

        } catch (error) {
            console.error('Error processing MQTT message:', error);
        }
    }

    /**
     * 切換捐贈彈出視窗的顯示狀態
     */
    function toggleDonatePopover() {
        const isHidden = donatePopover.classList.contains('hidden');
        closeAllPopovers(); // 統一先關閉所有視窗
        if (isHidden) { // 如果原本是關的，就把它跟遮罩打開
            donatePopover.classList.remove('hidden');
            popoverOverlay.classList.remove('hidden');
            donateAmountInput.value = ''; // 清除之前的輸入
            donateAmountInput.focus();
        }
    }

    /**
     * 處理捐贈確認
     */
    function handleDonation() {
        const amount = donateAmountInput.value;
        // 驗證輸入金額是否為正數
        if (!amount || parseFloat(amount) <= 0) {
            alert('請輸入有效的金額。');
            return;
        }

        const finalUrl = DONATE_URL.replace('{}', amount);
        window.open(finalUrl, '_blank', 'noopener,noreferrer');
        toggleDonatePopover(); // 開啟連結後關閉彈出視窗
    }

    /**
     * 設定並啟動 MQTT 客戶端
     */
    function setupMqttClient() {
        const client = mqtt.connect(MQTT_BROKER_URL);

        client.on('connect', () => {
            console.log('MQTT connected successfully!');
            client.subscribe(MQTT_TOPIC, (err) => {
                if (!err) {
                    console.log(`Subscribed to topic: ${MQTT_TOPIC}`);
                }
            });
        });

        client.on('message', (topic, message) => {
            handleMqttUpdate(message.toString());
        });

        client.on('error', (error) => {
            console.error('MQTT Connection Error:', error);
        });
    }

    // --- 事件監聽器綁定 ---
    // 這是將 HTML 元素與 JavaScript 函式連結起來的地方。
    // 我們不再使用 HTML 的 onclick 屬性，而是用 addEventListener 統一管理。
    // 這樣做讓 HTML 和 JavaScript 的職責分離，程式碼更清晰。
    filterSortToggle.addEventListener('click', toggleFilterSortPopover);
    closePopoverButton.addEventListener('click', toggleFilterSortPopover);
    applyFiltersSortButton.addEventListener('click', handleFilterSort);
    resetFiltersSortButton.addEventListener('click', resetFilterSort);
    donateButton.addEventListener('click', toggleDonatePopover);
    closeDonatePopoverButton.addEventListener('click', toggleDonatePopover);
    confirmDonationButton.addEventListener('click', handleDonation);
    popoverOverlay.addEventListener('click', closeAllPopovers);

    /**
     * 新增：應用程式初始化函式
     * 確保靜態資料先載入，再執行後續操作
     */
    async function initializeApp() {
        updateFilterSortUI(); // 根據 localStorage 初始化 UI
        await fetchStaticData(); // 首先載入靜態的排除列表
        await fetchAndDisplayItems(); // 然後載入主要的物品資料
        setupMqttClient(); // 啟動 MQTT 客戶端
        setInterval(fetchAndDisplayItems, UPDATE_INTERVAL_MS); // 設定定時更新
    }

    // --- 程式進入點 ---
    initializeApp(); // 執行應用程式初始化

}); // DOMContentLoaded 事件監聽器結束
