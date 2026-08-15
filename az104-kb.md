# AZ-104 知識庫（已校閱）

技能來源：Microsoft Learn 學習指南，技能衡量日期為 2026 年 4 月 17 日。
https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/az-104

這就是課。模擬必須實作此機制，而不是替講義加裝飾。

## 隱喻

Azure 是一座**控制平面城市**。一輛**部署推車**載著一筆 ARM 要求（即將成為的 VM，或滑桿指定的容器／App Service）。推車沿工廠線穿過五個對應考試網域的區。原則可把它導入拒絕岔線。網路存取是岔路：公用 IP、Bastion 或 Private Endpoint。

推車載的是要求狀態，不是貨物美術。長條／木箱／儀表就是下面那些即時欄位。

## 載具狀態（行進中的物件）

```
principal     { kind: user|group, upn, groups[] }
token         { valid, source: entra }
roles         [{ name, scope: mg|sub|rg|resource }]
actions       繼承後允許的動詞集合
policy        { requiredTags, allowedLocations, allowedSkus, denies[] }
tags          { env, owner, ... }
lock          none | CanNotDelete | ReadOnly
placement     { mg, sub, rg, location }
network       { vnet, subnet, nsgRules[], effectiveAction, path: public|bastion|pe }
storage       { account, redundancy, copies, access: key|sas|identity, diskGb }
compute       { type: vm|aca|app, sku, zones, instances }
monitor       { metricsOn, logRetentionDays, alerts[] }
backup        { vault: rsv|abv, retentionDays }
costMonthly   number
status        pending | denied | running
denyReason    string | null
```

## 站點（括號內為考試網域）

1. Entra 大門（身分 20–25%）— 綁定一位使用者與一個群組，將權杖標為有效。授權與 SSPR 在文案中點名，不模擬。
2. 角色櫃檯（身分）— 在選定範圍指派一個內建角色。計算有效動作：範圍向下繼承 管理群組 → 訂用帳戶 → 資源群組 → 資源。角色是加性的（聯集）。擁有者與使用者存取系統管理員可以指派角色；參與者不行。
3. 原則大廳（治理）— 評估 Azure Policy。缺少必要標籤、位置錯誤或不允許的 SKU → 拒絕，推車走拒絕岔線。原則不是 RBAC。
4. 標籤與鎖定場（治理）— 套用標籤；可選無法刪除／唯讀鎖定。鎖定即使對擁有者也會擋住刪除／更新。成本預算對照一份簡單的每月估算；Advisor 有點名，不建模。
5. VNet 場（網路 15–20%）— 把 NIC 放到一個子網路。評估 NSG：優先順序數字最小者勝出，先符合者勝。預設輸入拒絕。對等互連與 UDR 在文案中點名；有效 NSG 有計算。
6. 存取岔路（網路）— 分岔：公用 IP、Azure Bastion 或 Private Endpoint。服務端點 ≠ Private Endpoint（服務端點是通往 PaaS 的 VNet 路由；PE 是你子網路裡的一張 NIC）。
7. 倉庫（儲存體 15–20%）— 掛上作業系統磁碟與可選的 Blob 帳戶。備援複本數有計算。存取模型：帳戶金鑰 | SAS | Entra 身分。虛刪除／生命週期／版本設定有點名，不模擬。
8. 運算棚（運算 20–25%）— 佈建 VM（大小、可用性區域對可用性設定組）或分岔到 Azure Container Apps／App Service。ARM/Bicep 是推車全程攜帶的那張紙。ACR 是隔壁倉庫（登錄，不是執行階段）。
9. 瞭望塔（監視 10–15%）— 計量開啟、記錄保留、一條警示規則加一個動作群組。Network Watcher 有點名。
10. 保險庫（監視）— Recovery Services vault 或 Azure Backup vault，保留天數。Site Recovery 是配對區域上有標籤的墊，不是現場容錯移轉演練。

第 3 站拒絕之後，第 5–10 站不執行。

## 真實算術（必須活在 model.js）

### RBAC
內建角色 → 一小組動作（不是完整的資源提供者目錄）：

- 讀取者：讀取
- 參與者：讀取、寫入、刪除
- 擁有者：讀取、寫入、刪除、指派角色
- 使用者存取系統管理員：讀取、指派角色
- 虛擬機器參與者：讀取、寫入 VM、刪除 VM
- 儲存體 Blob 資料參與者：讀取 Blob、寫入 Blob、刪除 Blob

有效動作 = 範圍涵蓋該資源的所有相符指派之聯集。管理群組上的角色涵蓋訂用帳戶；資源群組上的角色不涵蓋兄弟資源群組。

若此次部署所需動作缺失（write 或 writeVm）則拒絕。

### 原則
輸入：必要標籤鍵、允許的位置[]、允許的 SKU[]。
拒絕原因是明確字串。原則拒絕即使 RBAC 允許也會勝出。

### NSG
規則：`{ priority, direction, access, protocol, port, source }`。
輸入規則依優先順序遞增排序。先符合者即為有效動作。
預設：輸入拒絕、輸出允許（Azure 預設）。
一條「管理」流量（443/22）會對照此表測試。

### 儲存體複本
- LRS：3 份，1 個資料中心，1 個區域
- ZRS：3 份，3 個可用性區域，1 個區域
- GRS：6 份，2 個區域（LRS + LRS）
- GZRS：6 份，3 個可用性區域 + 配對區域的 LRS

### 成本（指示性費率表，美元／月，730 小時）
VM：B1s 10、B2s 30、D2s_v5 70、D4s_v5 140
磁碟：4 + 0.15/GB
公用 IP：路徑為 public 則 4，否則 0
Bastion：路徑為 bastion 則 140，否則 0
儲存體帳戶：2 + 備援倍率（LRS 1、ZRS 1.2、GRS 2、GZRS 2.2）
App Service Basic：55；Azure Container Apps 30 × 執行個體
備份：0.05 × diskGb ×（retentionDays/30）

### 備份
retentionDays ∈ {7, 30, 90, 180}。RPO 顯示為「每日」（假設）。保險庫類型是標籤。

## 文案不得寫錯的考試事實

- 租用戶擁有 Microsoft Entra ID。訂用帳戶活在租用戶底下。管理群組巢狀於訂用帳戶之上。資源群組是部署／生命週期邊界。
- 名稱是 Microsoft Entra ID，不是 Azure AD。
- RBAC 是加性的。鎖定與 RBAC 正交。
- 參與者不能指派角色。
- Azure Policy 是治理，不是存取控制。
- 可用性區域 ≠ 可用性設定組。
- App Service 方案是調整與計費單位；Web 應用程式坐在方案上。
- ACR 存放映像。ACI 跑容器。Azure Container Apps 是應用程式平台（2026 年 4 月大綱上有）。
- Private Endpoint ≠ 服務端點。
- Recovery Services vault 與 Azure Backup vault 都出現在 2026 年大綱。
- Blob 虛刪除／版本設定／生命週期不是 Azure Backup。
- 此處權重：身分+治理 20–25、儲存體 15–20、運算 20–25、網路 15–20、監視 10–15。

## 保真帳本

已計算：RBAC 繼承 + 動作聯集；原則拒絕；NSG 先符合者勝；備援複本數；費率表每月成本；備份儲存估算。

已縮尺：角色動作只有少數動詞；一個 VNet、一個子網路、一張 NIC；一套原則；幾個 VM SKU。

已假設：離開 Entra 大門後權杖有效（沒有真正的 OIDC）；一個區域；一個訂用帳戶；730 小時月；每日備份 RPO。

已偽造：Entra 權杖密碼學；真正的 ARM/Bicep 編譯；即時 Azure 零售價；Site Recovery 容錯移轉；Advisor 建議；SSPR／授權／外部使用者；AzCopy；完整負載平衡器資料路徑。

僅指示：建築尺寸、區名、旁白裡任何不在面板上的數字。

## 校閱（第二遍）

已修正／盯住：
1. 不要畫成「訂用帳戶包含租用戶」。
2. 不要把原則當成一種 RBAC。
3. 不要讓參與者指派角色。
4. 不要把可用性區域與可用性設定組收成同一個控制項。
5. 不要把 ACR 當成運算執行階段。
6. 不要把服務端點等同 Private Endpoint。
7. 不要宣稱 Azure 價格是即時的——那是一小張費率表。
8. 不要宣稱結果沒有幻覺。校閱降低了錯誤率。
9. 刻意不在範圍內（關於裡點名，不成站）：SSPR、外部使用者、授權、物件複寫、主機加密深探、UDR 表、Application Gateway 對 LB 完整比較、KQL 查詢。
10. 運算類型滑桿是誠實涵蓋 VM + ACA + App Service 的方式，不必做三座城。

## 滑桿（每一支都必須推動模型）

- 角色 + 範圍
- 原則組合：關閉 | 要求標籤 | 標籤+位置+SKU
- 鎖定：無 | 無法刪除 | 唯讀
- 存取路徑：公用 | Bastion | Private Endpoint
- 儲存體備援
- 運算類型：VM | Azure Container Apps | App Service
- VM／方案大小
- 備份保留

## 標題

AzureWorks — Azure 系統管理員真正把資源落地的方式。
