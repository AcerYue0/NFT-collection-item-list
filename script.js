// --- 設定 ---
const API_URL = ''; 
const UPDATE_INTERVAL_MS = 30 * 60 * 1000; // 30 分鐘

// --- 全域狀態 ---
// 用來儲存當前顯示的資料，以便比較更新
let masterData = {};
// 用來儲存當前的篩選條件
let currentFilters = {
    itemName: '',
    priceMin: null,
    priceMax: null
};
// 用來儲存當前的排序條件
let currentSort = {
    by: 'itemName', // 'itemName', 'price', 'updateTimeUTC'
    order: 'asc'    // 'asc', 'desc'
};


// --- DOM 元素 ---
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
const sortAscRadio = document.getElementById('sort-asc');
const sortDescRadio = document.getElementById('sort-desc');
const applyFiltersSortButton = document.getElementById('apply-filters-sort');
const resetFiltersSortButton = document.getElementById('reset-filters-sort');

/**
 * 將 UTC timestamp (秒) 轉換為本地時間的可讀字串
 * @param {number} utcSeconds - 從 API 來的 UTC timestamp (以秒為單位)
 * @returns {string} 格式化後的日期時間字串
 */
function formatTime(utcSeconds) {
    if (!utcSeconds || typeof utcSeconds !== 'number') {
        return 'N/A';
    }
    // JavaScript Date 物件需要毫秒，所以要乘以 1000
    const date = new Date(utcSeconds * 1000);
    // toLocaleString() 會轉換成使用者瀏覽器的本地時間格式
    return date.toLocaleString();
}

/**
 * 根據資料渲染或更新表格，並對變動的行應用動畫
 * @param {object} processedData - 經過篩選和排序後的資料 (Object 形式)
 */
function renderTable(processedData) {
    const existingRows = new Map();
    // 建立現有 DOM 列的 Map 以便快速查找
    for (const row of tableBody.children) {
        if (row.dataset.itemName) {
            existingRows.set(row.dataset.itemName, row);
        }
    }

    // 迭代新資料來新增或更新列
    for (const [itemName, itemDetails] of Object.entries(processedData)) {
        // 注意：這裡的 oldDetails 仍然是從 masterData 中獲取，用於比較原始數據的變動
        // 而不是 processedData 中的變動，因為動畫是基於原始數據的實際更新
        const oldDetails = masterData[itemName];
        const priceText = itemDetails.price === -1 ? '市場上無此道具' : itemDetails.price.toLocaleString();
        const formattedTime = formatTime(itemDetails.updateTimeUTC);

        const rowContent = `
            <td>${itemName}</td>
            <td>${priceText}</td>
            <td>${formattedTime}</td>
        `;

        let row;
        let isNewRow = false;
        let hasDataChanged = false;

        if (existingRows.has(itemName)) {
            row = existingRows.get(itemName);
            // 檢查資料是否有變動
            if (oldDetails && (oldDetails.price !== itemDetails.price || oldDetails.updateTimeUTC !== itemDetails.updateTimeUTC)) {
                hasDataChanged = true;
            }
            // 移除，表示此列已處理
            existingRows.delete(itemName);
        } else {
            // 新增列
            row = document.createElement('tr');
            row.dataset.itemName = itemName; // 設定 data-item-name 以便下次查找
            tableBody.appendChild(row); // 先添加到 DOM，再更新內容
            isNewRow = true;
            hasDataChanged = true; // 新增的行也視為有變動，觸發動畫
        }

        // 只有當內容實際改變時才更新 innerHTML，避免不必要的 DOM 操作
        if (isNewRow || hasDataChanged || row.innerHTML !== rowContent) {
            row.innerHTML = rowContent;
            // 套用更新動畫
            // 確保動畫可以重複觸發，先移除再添加
            row.classList.remove('row-updated');
            // 使用 requestAnimationFrame 確保 class 移除後有足夠時間讓瀏覽器重繪，
            // 這樣再次添加 class 時動畫會重新觸發。
            requestAnimationFrame(() => {
                // 套用更新動畫
                row.classList.add('row-updated');
                row.addEventListener('animationend', () => row.classList.remove('row-updated'), { once: true });
            });
        }

        // 統一處理 'unavailable' 樣式
        if (itemDetails.price === -1) {
            row.classList.add('unavailable');
        } else {
            row.classList.remove('unavailable');
        }
    }

    // --- 移除不再存在的列 ---
    // Map 中剩下的就是舊資料中存在，但新資料中沒有的列
    for (const row of existingRows.values()) {
        row.remove();
    }
}

/**
 * 應用篩選條件
 * @param {object} data - 原始資料 (Object 形式)
 * @param {object} filters - 篩選條件
 * @returns {object} 篩選後的資料 (Object 形式)
 */
function applyFilters(data, filters) {
    let filtered = {};
    for (const [itemName, itemDetails] of Object.entries(data)) {
        let match = true;

        // 道具名稱篩選
        if (filters.itemName && !itemName.toLowerCase().includes(filters.itemName.toLowerCase())) {
            match = false;
        }

        // 價格範圍篩選
        if (match && filters.priceMin !== null && itemDetails.price !== -1 && itemDetails.price < filters.priceMin) {
            match = false;
        }
        if (match && filters.priceMax !== null && itemDetails.price !== -1 && itemDetails.price > filters.priceMax) {
            match = false;
        }

        if (match) {
            filtered[itemName] = itemDetails;
        }
    }
    return filtered;
}

/**
 * 應用排序條件
 * @param {object} data - 待排序的資料 (Object 形式)
 * @param {object} sort - 排序條件
 * @returns {object} 排序後的資料 (Object 形式)
 */
function applySort(data, sort) {
    // 將物件轉換為陣列以便排序
    const dataArray = Object.entries(data);

    dataArray.sort((a, b) => {
        const [itemNameA, itemDetailsA] = a;
        const [itemNameB, itemDetailsB] = b;

        let valA, valB;

        switch (sort.by) {
            case 'itemName':
                valA = itemNameA.toLowerCase();
                valB = itemNameB.toLowerCase();
                break;
            case 'price':
                // 處理 -1 (無價格) 的情況，讓它們排在最後
                valA = itemDetailsA.price === -1 ? Infinity : itemDetailsA.price;
                valB = itemDetailsB.price === -1 ? Infinity : itemDetailsB.price;
                break;
            case 'updateTimeUTC':
                valA = itemDetailsA.updateTimeUTC;
                valB = itemDetailsB.updateTimeUTC;
                break;
            default:
                return 0;
        }

        if (valA < valB) {
            return sort.order === 'asc' ? -1 : 1;
        }
        if (valA > valB) {
            return sort.order === 'asc' ? 1 : -1;
        }
        return 0;
    });

    // 將排序後的陣列轉換回物件形式 (保持原始 key-value 結構)
    // 這裡的順序會被 Object.entries 和 Object.fromEntries 保證
    return Object.fromEntries(dataArray);
}

/**
 * 主要功能：抓取並顯示道具資料
 */
async function fetchAndDisplayItems() {
    const isFirstLoad = Object.keys(masterData).length === 0;

    lastUpdatedText.textContent = '正在更新...';
    
    // 只有在第一次載入時才顯示全頁的 loading indicator
    if (isFirstLoad) {
        loadingIndicator.classList.remove('hidden');
        table.classList.add('hidden');
    }
    errorMessage.classList.add('hidden');

    try {
        const response = await fetch(API_URL);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const newData = await response.json();

        // 檢查是否有資料
        if (isFirstLoad && Object.keys(newData).length === 0) {
            loadingIndicator.innerText = '找不到任何道具資料。';
            lastUpdatedText.textContent = '無資料';
            return;
        }

        // 渲染表格
        renderTable(newData);

        // 更新 masterData 以供下次比對
        masterData = newData;

        // 資料載入成功
        if (isFirstLoad) {
            loadingIndicator.classList.add('hidden');
            table.classList.remove('hidden');
        }
        lastUpdatedText.textContent = `最後更新：${new Date().toLocaleString()}`;

    } catch (error) {
        console.error('抓取資料時發生錯誤:', error);
        errorMessage.classList.remove('hidden');
        if (isFirstLoad) {
            loadingIndicator.classList.add('hidden');
        }
        lastUpdatedText.textContent = '更新失敗！';
    }
}

// 當頁面載入完成後，立即執行，並設定定時更新
document.addEventListener('DOMContentLoaded', () => {
    // 1. 立即載入第一次資料
    fetchAndDisplayItems();

    // 2. 設定每隔 30 分鐘自動更新一次
    setInterval(fetchAndDisplayItems, UPDATE_INTERVAL_MS);
});
