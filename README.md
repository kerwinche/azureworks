# AzureWorks

一座等角控制平面城市，帶一筆 ARM 要求走過 AZ-104 部署路徑。推車離開 Entra 大門，載著一位使用者、一枚權杖與一個期望資源：在角色櫃檯綁定、在原則大廳裁決、打上標籤與鎖定、放到子網路、依存取路徑分岔、在倉庫複製、在運算棚佈建、從瞭望塔監看，並保留在保險庫。

若原則或 RBAC 拒絕要求，推車走拒絕岔線，其餘的場不再執行。存取是路上的岔路：公用 IP、Azure Bastion 或 Private Endpoint。

純靜態站。沒有建置步驟、沒有相依套件、沒有網路呼叫。

引擎是 PacketPost／learnscape 等角解說器。領域是 Azure 系統管理。考試大綱 © Microsoft。技能衡量日期為 2026 年 4 月 17 日。

## 執行

用瀏覽器開啟 `index.html`。就這樣。

若要本機伺服：

```
python3 -m http.server 8765
# → http://localhost:8765
```

## 操作

| | |
|---|---|
| **Space** | 播放／暫停（可無限停在閱讀停留） |
| **S** | 正好前進一站 |
| **R** | 重設並重播慢速導覽 |
| **F** | 切換鏡頭跟隨 |
| **L** | 切換標籤 |
| 拖曳 | 平移 · 滾輪：縮放 · 雙擊：顯示整座城 |
| **+ − ⤢** | 左側縮放控制；**⤢** 顯示整座城 |
| 點一站 | 釘選該站說明（點空白地面繼續） |

每一支滑桿都會立刻重算 `Azure.compute()`：**角色**、**範圍**
（管理群組／訂用帳戶／資源群組）、**原則組合**（關閉／要求標籤／標籤+位置+SKU）、
**鎖定**、**存取路徑**、**備援**、**運算類型**、**大小**、
**備份保留**。面板上的數字會動，因為模型動了。

## 步調

推車第一次抵達一站時停 9–26 秒，依該站說明長度縮放。之後到訪只停短拍。你已經讀過的（`tour.seen`）在按**執行**後仍保留；**重設**（⟲）忘掉並重播慢速導覽。

## 站點

| 站點 | 考試網域 | 模型做什麼 |
|---|---|---|
| Entra 大門 | 身分 20–25% | 綁定使用者與群組；將權杖標為有效（假設） |
| 角色櫃檯 | 身分 | 由角色 + 範圍聯集動作；管理群組→訂用帳戶→資源群組繼承 |
| 原則大廳 | 治理 | 必要標籤／允許位置／允許 SKU；拒絕 → 拒絕岔線 |
| 標籤與鎖定場 | 治理 | 標籤 + 無法刪除／唯讀（與 RBAC 正交） |
| VNet 場 | 網路 15–20% | NSG 先符合者勝，優先順序遞增；預設輸入拒絕 |
| 存取岔路 | 網路 | 公用／Bastion／Private Endpoint（服務端點 ≠ PE） |
| 倉庫 | 儲存體 15–20% | LRS/ZRS = 3 份；GRS/GZRS = 6 份；金鑰／SAS／身分 |
| 運算棚 | 運算 20–25% | VM 或 Azure Container Apps 或 App Service；可用性區域 ≠ 可用性設定組 |
| 瞭望塔 | 監視 10–15% | 計量、記錄保留、一條警示 |
| 保險庫 | 監視 | RSV 或 Azure Backup vault；`0.05 × diskGb × (days/30)` |
| 拒絕墊 | — | 原則或 RBAC 已拒絕；原則大廳之後的場不再執行 |

## 保真帳本

**已計算：** RBAC 繼承 + 動作聯集；原則拒絕；NSG 先符合者勝；
備援複本數；費率表每月成本；備份儲存估算。

**已縮尺：** 角色動作只有少數動詞；一個 VNet、一個子網路、一張
NIC；一套原則；幾個 VM SKU。

**已假設：** 離開 Entra 大門後權杖有效（沒有真正的 OIDC）；一個區域；
一個訂用帳戶；730 小時月；每日備份 RPO。App Service 方案
倍率與 Azure Container Apps 執行個體數由大小滑桿對應，讓那支滑桿永遠推動一個數字。

**已偽造：** Entra 權杖密碼學；真正的 ARM/Bicep 編譯；即時 Azure
零售價；Site Recovery 容錯移轉；Advisor 建議；SSPR／
授權／外部使用者；AzCopy；完整負載平衡器資料路徑。

**僅指示：** 建築尺寸、區名、旁白裡任何不在面板上的數字。

費率表（美元／月，730 小時）：VM B1s 10、B2s 30、D2s_v5 70、D4s_v5
140；磁碟 4 + 0.15/GB；公用 IP 4；Bastion 140；儲存體帳戶 2 +
備援倍率（LRS 1、ZRS 1.2、GRS 2、GZRS 2.2）；App Service
Basic 55 × 方案係數；Azure Container Apps 30 × 執行個體；備份
`0.05 × diskGb × (retentionDays / 30)`。

## 本頁不會寫錯的事實

- 租用戶擁有 Microsoft Entra ID。訂用帳戶活在租用戶底下。管理群組巢狀於訂用帳戶之上。
- 名稱是 Microsoft Entra ID，不是 Azure AD。
- Azure Policy 是治理，不是存取控制。鎖定與 RBAC 正交。
- 參與者不能指派角色。
- 可用性區域不是可用性設定組。
- ACR 是登錄，不是執行階段。
- Private Endpoint 不是服務端點。
- 價格是一小張費率表，不是即時 Azure 價格。

## 版面

```
index.html          標記、控制項、含保真帳本的關於對話框
css/styles.css      淺色、印刷感介面
js/iso.js           等角投影、實體圖元、路線輔助（引擎）
js/model.js         課：RBAC、原則、NSG、複本、成本、備份
js/world.js         路線、站點、區、建築、小物件
js/sim.js           帶一筆要求穿越城市的狀態機
js/render.js        canvas 2D 畫家演算法彩現
js/ui.js            面板、旁白、控制項
js/main.js          鏡頭、輸入、影格迴圈（引擎）
```

`World.routes` 存放推車行駛的折線。`Sim.advanceRoute()`
有兩處分岔：原則大廳之後，拒絕走 `reject`；存取岔路之後，
滑桿選 `public`、`bastion` 或 `pe`。推車上的木箱是複本數。儀表是費率表總額。

## 驗證變更

```
for f in js/*.js; do node --check "$f" || echo "FAIL $f"; done
```

然後伺服並開啟 `http://localhost:8765/`。

```
python3 -m http.server 8765
```

MIT。引擎：learnscape／PacketPost。考試大綱：Microsoft。
