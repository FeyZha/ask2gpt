# Ask2GPT — Chrome Relay 编程助手：架构与安全边界

本文描述 0.1.3 和 Relay 协议 v15。

产品架构目标是在 VS Code 中提供 Codex 风格的对话体验，同时使用用户已登录的 ChatGPT 网页
会话作为回答来源：模型、消息、流式回答、标题和当前可见历史以 ChatGPT 页面为事实来源。
所有合法问题使用同一 Chrome Relay 路径，不按意图在本地拦截或切换到其他产品。

## 组件

```text
React Webview
    │ 经过运行时校验的 VS Code 消息
    ▼
VS Code Extension Host（每窗口独立）
    ├─ Controller / ContextService
    ├─ ConversationStore（仅 globalStorageUri）
    └─ BrowserChatBackend / ChromeRelayServer
            │ 127.0.0.1:32171–32180 / WebSocket / protocol v15
            ▼
Chrome MV3 Service Worker
    ├─ 自动发现、重连、窗口路由、标签页、并发与恢复
    └─ isolated-world Content Script
            │ 只操作已映射标签页的可见 DOM
            ▼
https://chatgpt.com/
```

不存在 OpenAI API、Codex、Shell、Git、测试执行、补丁、仓库搜索或工作区写入后端。
`pnpm verify:boundaries` 静态校验这些不变量和扩展权限快照。

## protocol v15 自动连接

- 每个 VS Code 窗口在 `32171–32180` 中租用一个空闲 loopback 端口，只监听
  `127.0.0.1`。
- VS Code 扩展以无条件激活事件作为第一入口，因此安装、窗口 reload 或 Extension Host
  单独重启后，无需先打开侧栏或运行命令就会恢复监听。若初次监听暂时失败，Host 按
  250、500、1000、2000、5000、10000 毫秒上限自动重试，直到取得端口或宿主关闭。
- 每个窗口拥有独立 `instanceId`、端口、会话存储槽位和消息路由；端口不作为身份或
  凭据。
- Chrome Service Worker 扫描固定端口段，并可同时维护到多个 VS Code 窗口的连接。
- v15 连接使用显式 WebSocket subprotocol `ask2gpt.v15`。宿主先发送 `relay.ready` 固定
  本窗口的 `instanceId`，Chrome 再发送 `relay.hello`；宿主校验 loopback Origin、固定扩展
  ID、协议版本、产品发布线、消息 schema、方向和目标 `instanceId`。v15 只接受 `0.1.0` 起且
  产品补丁版本一致或相差 1 的 `0.1.x` 双端临时互连，正式安装仍要求同版；低于该版本、相差
  两版及以上或跨协议发布线仍然 fail closed。
- `relay.hello/relay.ready` 是版本和路由协商，不是密码学身份认证。
- v15 不使用验证码、`pair.request`、HMAC、nonce、`pairingId`、共享密钥或 SecretStorage
  配对记录。旧配对数据不参与 v15 连接。
- WebSocket 和应用心跳用于存活检测。断开后 Chrome 按短退避重新扫描；命令面板中的
  “检查 Chrome 连接”可以立即触发新一轮发现。
- 只有完整 `relay.ready/relay.hello` 握手成功后才清零重连退避；仅 TCP/WebSocket 打开但
  版本校验失败时继续按 1、2、5、10、30 秒上限退避，避免旧端高频连接和日志洪泛。
- Host 返回的 `relay.error` 在 Relay 本地状态处于握手或已发送 `relay.hello` 后都会被消费为
  连接诊断，不会误投递成会话命令；协议关闭码和安全长度内的关闭原因也会转成可读提示。
- 同一连接内的 envelope ID 防重放、协议方向和 `instanceId` 校验用于避免误路由，不能
  证明对端是可信本机进程。
- v15 的 `conversation.release` / `conversation.released` 是 0.1.2 起可用的可选页面租约优化。
  Host 以 `TAB_LEASE_MINIMUM_RELAY_VERSION = [0, 1, 2]` / `supportsTabLeases()` 做 rolling
  capability gate：连接 0.1.1 Relay 时仍发送不含 `purpose` 的 legacy `conversation.open`，并且
  不发送 `conversation.release`；确认 Relay 至少为 0.1.2 后，才发送 `purpose` 和 release。
  Relay 只把 release 当成启动空闲证明的提示；连接中断或 3 秒内没有 ACK 都不得影响会话切换、
  发送、历史持久化或恢复的正确性。该能力保持 v15 的向后兼容可选字段，不提升协议版本。相邻
  patch 的兼容窗口只用于先后升级仍在运行的双端，不承诺把已写入 0.1.2 状态的 Relay 二进制降回
  0.1.1；二进制回滚必须视为不支持，正式安装始终应让 VSIX 与 Relay 保持同版。

VS Code 窗口 reload 后重新取得自己的存储槽位和稳定路由；同一工作区的并行窗口会租用
不同槽位，避免覆盖记录、替换 socket、接管错误标签页或串流其他窗口的回答。

## ChatGPT 会话与标签页边界

Chrome Relay 持久保存一个全局 `Ask2GPT` Project 绑定：

- 绑定身份必须由规范化的 `/g/<scope>/project` URL 与同一侧栏条目或受限目录数据中的精确
  `Ask2GPT` 名称共同证明；正文链接、页面标题、URL slug 或仅有 Project-shaped URL 均不足以
  建立绑定；
- v15 使用 `projectBindingV6`（记录 version 5 与严格验证 provenance）作为持久可信记录；旧 V5
  只作为待验证候选，同一 scope 严格核验通过后才迁移；
- 所有 VS Code 窗口共享 Chrome `storage.local` 中的绑定，不需要逐窗口设置；
- 可信 V6 在普通 Chrome/Service Worker 重启后直接恢复；页面未加载、后台休眠、selector 暂时
  不可用等通用故障不会删除它，也不会触发全局发现去替换原 scope；
- 发现另一个同名 Project 不会隐式覆盖当前绑定；更换 scope 只能由用户在 Popup 中显式重新绑定；
- 新会话只能从绑定 Project 根页创建，并在首次发送、URL 跳转和快照同步时持续校验同一 scope；
- 未绑定或跳出 scope 时 fail closed，不回退到普通 ChatGPT 根页，也不自动重发问题；
- 自动发现只拥有一个临时首页标签：并发/后续重试复用同一标签；仅登录、挑战或缺少
  Ask2GPT Project 等确需用户处理时保留并聚焦，临时故障时立即清理；
- 已有普通会话 URL `https://chatgpt.com/c/...` 仅作为升级兼容映射继续恢复；
- 本地换会话、重命名或删除不调用 ChatGPT 的移动、重命名或删除能力。
- `conversation.close` 仍是本地会话删除使用的逻辑清理命令，不承担池回收职责。Relay 自建页在
  请求关闭失败时保留映射并返回可重试错误；借用页和旧版来源不明页返回 `left-open`、解除本地
  映射但保留 Chrome 标签页。成功返回与请求 ID 关联的 `conversation.closed`，不以固定延时
  假定关闭成功。

Chrome 为映射标签记录三类 provenance：

1. `created`：当前 Relay 明确创建，可在满足全部安全条件时进入受管池；
2. `borrowed`：按精确 `instanceId + conversationId + remoteUrl` 采用的既有页面，只用于该映射；
3. `legacy-unknown`：升级前记录或会话存储丢失后无法证明来源的页面，始终按未知来源处理。

缺少 provenance 的旧记录只迁移为 `legacy-unknown`，不会猜测成 `created`。当前 schema 要求
`borrowed` 同时写入 `owned: false`，但这只是 0.1.2 运行时和持久化格式的不变量，不是旧二进制的
回滚保护机制。`borrowed` 与 `legacy-unknown` 不会被 0.1.2 自动导航、复用或关闭；删除本地会话时
也只解除映射。Popup 会报告这些页面或可能的旧 Project 根页，用户必须先在 Chrome 标签栏确认
内容，再手动关闭。不得用 0.1.1 Relay 打开 0.1.2 写入的会话状态。

### 标签页租约、复用与回收

- 新建的空白草稿是纯 Host 状态：活动会话 ID 写入 workspace state，并在 VS Code Reload 后复用
  同一安全 ID；它没有远端 URL 和可见消息时不做被动预热。只有首次发送或明确的 dispatch intent
  才打开/租用 ChatGPT 页面；点击、聚焦或开始输入 Composer 会发出 dispatch intent，因此可能在
  真正提交前预热页面，但不会把问题写入网页或发送。
- Relay 以 `MAX_CONCURRENT_RUNS = 3` 作为受管页面软容量，并通过一个全局分配器串行完成采用、
  复用和创建。不同 VS Code 窗口仍可并行运行，但同一物理标签在任一时刻只有一个
  `instanceId + conversationId + leaseEpoch` 租约。
- 复用只选择 `created` 的最久未使用页。Worker 侧必须确认没有活动 run、未确认终态、历史屏障、
  canonicalization、可见性/debugger 租约、导航、快照同步、预热或业务命令；Chrome 页还必须非
  active/highlighted/pinned/audible 且 Project scope 精确一致。
- Content Script 通过 `content.inspectIdleState` 另行证明：页面没有活动 run，恰好一个可见且
  可写的 composer，草稿为空，没有附件、停止/响应控件或可见 modal。任一证据缺失、歧义、超时
  或 selector 版本不兼容都 fail closed；页面保持原租约。
- 若三个受管页都受保护或无法证明空闲，Relay 为正确性创建临时 overflow 页面，不抢占、不清空
  草稿，也不关闭用户页面。安全页稍后才按 LRU 复用或被 GC 回收。
- 用户在 Chrome 中手动激活受管页后记录 `userClaimedAt`，永久退出自动复用与自动关闭候选；Relay
  为发送/恢复执行的内部激活不会误标为用户接管。
- 一分钟周期 GC 在 Host 已连接时只关闭空闲至少 10 分钟的 surplus `created` 页，并至少保留一个
  warm page；对应 Host 断开且最后使用已满 30 分钟后，才可关闭最终安全空闲页。每次关闭前重新
  执行 Worker 检查与页面空闲证明。
- Relay Popup 显示 managed/active/reusable/protected、borrowed、legacy candidates 与软容量的
  状态快照；`reusable`、legacy candidates 和预计可清理数都是估算，可能在页面变化后立即失效。
  “清理安全闲置页”会在执行时二次检查并只关闭当前再次通过完整证明的 `created` 页，因此最终
  关闭数可以少于 Popup 先前显示的候选数；provenance 警告不构成自动删除授权。

`tabId + instanceId + conversationId + remoteUrl` 共同约束命令和返回事件；物理页换租约时再以单调
`leaseEpoch` 阻止迟到的分配工作覆盖新租约。Relay 不通过 ChatGPT 左侧栏寻找会话，不枚举账号
历史，也不把“标题相同”当作会话身份。仅在绑定缺失时，Relay 会检查已打开 ChatGPT 标签页的
当前可见 Project 路由和名称，以自动识别 `Ask2GPT`；用户也可在 Popup 中显式绑定当前可见 Project。

Chrome Relay 是运行中标签页映射的权威；Host 的 `remoteUrl` 是标签页关闭或重启后的恢复缓存。
稳定映射由 `instanceId + conversationId + remoteUrl` 标识。对于仍然存在的 owned 标签页，Host
的陈旧临时地址绝不能把浏览器从当前正式 B 导航回 A；用户手动浏览到无关会话 C 也不能把映射
从 B 改成 C，重新选择本地会话或发送时恢复 B。

生成期间使用 `initial → canonicalizing` 记录。当前 `instanceId + conversationId + runId` 与
owned `tabId` 精确匹配时，Content Script 的可见事件可以在整个 run 生命周期内采用 ChatGPT
产生的当前 conversation URL，不设置 30 秒或“一次性最终 ID”限制。`Tab.active` 仅表示标签
在 Chrome 窗口中是否被选中，不是会话归属证明，因此不会改变映射、授权或恢复状态。

生成结束后，Relay 从同一个 owned 标签页读取经过 schema、大小和 origin 校验的完整可见
transcript snapshot。同一远端身份的快照可以更新 URL 形式、标题和当前可见分支；跨远端身份
更新必须由精确 run 证明。若回答结束时 ChatGPT 尚未生成 URL，稍后快照还必须同时匹配该 run
的问题和最终回答指纹才允许首次绑定。用户主动浏览到无关对话只会被忽略，不会导入历史或
持久化新绑定；Relay 不读取侧栏或其他标签页来猜测目标。

派发前 Service Worker 复核 owned tab，Content Script 在填写前和点击前再次核对当前页面。
标签被关闭后才失去 tab 所有权；下次发送可按 Host 缓存的最后有效 URL 恢复。页面无法形成
合法 ChatGPT conversation URL、DOM 不完整、登录/CAPTCHA 或 selector 有歧义时仍然 fail
closed，不会自动重放问题或切换到其他后端。

对于已映射标签页，Content Script 只读取当前可见 DOM：

- 当前可见会话标题；
- 当前分支中可见的用户和助手消息；
- 当前可见的发送、停止和重新生成控件；
- 页面暴露的 canonical 会话 URL。

它不会读取其他侧栏条目、其他标签页、其他 Project、隐藏分支或未展开的历史。页面有
多个回答分支时，`conversation.snapshot` 只描述用户当前可见分支；切换分支后下一次
快照可以更新本地视图，但 Relay 不枚举所有分支。

## 请求路径

1. Webview 只提交文本和用户主动触发的操作；宿主对每条消息做类型、长度和 ID 校验。生成中
   的排队、停止以及“停止后发送”还必须携带渲染该操作时的 `targetRunId`；迟到命令与当前
   run 不一致时 fail closed。
2. 每个会话拥有独立的待发送草稿上下文，新会话默认不附加任何代码。用户可通过 Ask2GPT 侧栏
   标题栏、编辑器标题栏、右键菜单、命令面板或黄色灯泡中的动作明确附加当前选区，或通过
   Composer 的 `+` 附加当前选区/当前文件/选择文本文件。Notebook 使用独立的 Cell 标题栏、Notebook
   工具栏、命令面板和 Composer 入口，附加 Cell 内选区、当前 Cell 或多个所选 Cell；这些快照都来自
   编辑器内存缓冲区，并且在 Composer 中可见、可预览和可移除。
   空白新会话 ID 在 Reload 后保持稳定，但没有远端 URL 与可见消息时不触发 Chrome 页面预热。
3. 宿主对所有合法非空 prompt 使用同一发送和并发检查，不做本地意图分类或产品 handoff。
4. 宿主按会话保存、去重并持久化待发送 Context Bundle。会话切换不得清空草稿或把附件
   带入其他会话；发送时原子冻结用户可见的快照。可见 Prompt 始终只有用户问题，所有快照均随
   `conversation.send` 作为受限文本附件交给 Chrome，并以内存 `File` 上传。
5. 每个本地 run 只产生一次 `conversation.send`。Host 与 Relay 不因超时、断线、SPA 替换或
   恢复重发该命令；Content Script 只处理这一命令对应的一次页面提交事务。
6. Chrome 按明确映射选择标签页；新会话从已绑定 Project 根页创建。Service Worker 与
   Content Script 复核 Project scope 和唯一可见输入控件后才填写并发送。发送确认必须来自
   本 run 的页面请求生命周期、可见用户消息、Project 会话 URL、生成控件或新 assistant 节点
   等正向证据；原 composer 或 SPA 替换后的 composer 为空，单独出现时都不算确认。
7. `document_start` 的 MAIN-world 桥接器把待发送 `runId` 只绑定到下一次 ChatGPT 页面自身的
   conversation 请求，报告 submitted、response-started、response-complete 或
   response-error。它克隆并增量解码本 run 的 assistant 响应，发布当前完整 Markdown 快照。
8. Relay 默认开启增强后台接收。Service Worker 在发送前只对 owned ChatGPT 标签页附加
   `chrome.debugger`，并在每次页面按钮激活前用 CDP 保持 exact renderer active、模拟页面焦点；
   这些命令不聚焦操作系统窗口。调试通道同时读取本轮 SSE。
   Content Script 完成输入、唯一按钮、Project、run 和发送前历史基线校验后，为 owned scope、composer
   与发送按钮添加当前 `runId` 标记；Service Worker 通过受限的 `chrome.scripting.executeScript`
   在页面 MAIN world 复核三者唯一且同 scope，并在 1.2 秒内取得四次稳定的按钮几何/命中样本；
   按钮必须启用、可见，且中心或四个象限内至少一个内部点始终未被遮挡。验证只返回命中点，不调用
   页面脚本 `click()`、表单提交或键盘事件。Service Worker 再通过同一个 debugger 会话执行
   `Page.bringToFront`，复核 exact tab 仍为 home window 的 active tab，并仅派发一次 CDP 左键
   move/press/release。关闭“增强后台接收”时仅为这次指针动作建立短时 debugger 会话，不启用
   Network 域并在释放后立即断开。从 `mousePressed` 开始结果即视为不确定且不可重试，只能进入只读恢复。
   若 exact owned 标签页在发送前处于后台，Service Worker 会在不聚焦 Chrome 窗口的情况下短暂选择
   该标签页，并要求间隔 350 ms 的两次 composer 稳定就绪证明。最小化的 home window 会使用 Chrome
   自己维护的合法 restore bounds、以 `focused=false` 临时恢复为 normal，使 React 与页面提交处理器
   真正运行；终态后恢复原边界、原 active 标签页和最小化状态。Relay 不再提供完全离屏坐标，以符合
   Chromium“窗口至少 50% 位于可见显示区域”的约束。只读历史预热可以把标签页放入最大 980×760、
   `focused=false` 的临时窗口，但非幂等发送边界明确拒绝临时窗口，必须先回到 home window。
   用户在租约期间主动切换标签页、聚焦窗口或改变窗口状态时，恢复逻辑保留用户的新选择。
   前台、后台和最小化场景共用同一 MAIN-world 验证与 trusted-pointer 路径；若 1.5 秒内没有请求生命周期、当前用户消息或
   composer 变化，并且原草稿仍完整，则立即准确报告“未发送”，
   而不是继续等待完整的十秒确认窗口。若 SSE 返回 `stream_handoff`，捕获保持到对应
   `conversation-turn-*` WebSocket
   topic 的 `encoded_item` 到达 `[DONE]`，同时忽略共享连接上的其他 topic；CDP 事件按每个捕获
   串行处理，完整响应体发现的 handoff 也会继续等待已排队的 WebSocket 帧。终态或失败后立即
   detach。这条浏览器进程侧通道不依赖最小化窗口中的 React 渲染节拍。
9. `MutationObserver` 同时读取最新可见 assistant 节点并序列化为安全 Markdown，作为页面
   归属校验与网络流不可用时的恢复来源；首个非空快照先发送再异步持久化恢复提示，后续完整
   快照按约 120ms 合并，Chrome session 写入不进入首字显示关键路径。
10. Extension Host 向 Webview 发送只含
    `conversationId + messageId + runId + markdown` 的轻量流式更新。终态、会话切换和元数据
    变化才发送完整原子状态。
11. 终态按 `instanceId + conversationId + runId + tabId` 关联。旧 run 的迟到事件不能结束
    新 run，也不能进入其他窗口。
12. 当页面出现 canonical URL 或可见标题时，Relay 发出映射和 `conversation.title` 更新；
    宿主不会反向调用网站重命名。
13. 恢复已映射会话时，`conversation.snapshot` 只同步该标签页当前可见分支历史，不扫描
    ChatGPT 全部侧栏来重建本地状态。

Ask2GPT 的自动读取严格限于活动编辑器中的当前选区或当前文件，不枚举、搜索或上传工作区，
也不会根据问题推测应读取哪些其他文件。用户移除默认附件后，本草稿保持无上下文且不会偷偷
重新添加。无上下文时 ChatGPT 只看到原始问题；有上下文时页面仍显示原始问题，并以代码文件
胶囊封装用户发送前可见的快照，不把源码和运输元数据展开到问题正文。

### 源码追踪

- 待发送和已发送的上下文卡片只向 Host 发送 `conversationId + contextId`；Host 从权威
  `AppState` 反查 URI，并统一校验 `file`、`untitled`、`vscode-remote` scheme、文件 basename
  和敏感文件策略。selection 必须以精确快照在当前文档中唯一重定位；内容缺失或重复时分别按
  stale/ambiguous fail closed，不静默使用旧行号。整文件附件只接受 raw/normalized hash、唯一原文
  或唯一邻接行锚点证明的范围；回答行号与函数定位复用同一解析器，不把当前同号行伪装成原引用。
- Host 只从每条 assistant 前最近一条 user turn 的附件和终态回答派生 `SourceTraceHint`；只有
  已证明落在这些附件内的 `file:line` 和定义名进入 Webview 可点击白名单，未附加引用保持普通文本。
  派生范围仅限当前活动会话，并缓存未变化的会话；单次最多检查最近 200 条终态 assistant，且对
  文件引用与符号总数设上限，避免长期历史阻塞 Extension Host 或膨胀 Webview 状态。
- 点击回答中的源码按钮时，Webview 只发送
  `conversationId + assistantMessageId + kind + reference`，不发送 URI；Host 必须重新解析权威
  assistant markdown，确认引用真实存在，再只在最近 user turn 的 context 和附件别名中解析。
- 函数定位仅对这些已附加 URI 调用只读的 Document Symbol Provider；无语言服务时可从有界快照
  的定义索引回退，且定义范围仍必须位于附件证据内。文件名或定义有歧义时使用 VS Code QuickPick，
  不随机选择。
- 每个普通文本上下文随加密会话持久化 `SourceAnchorV1`：精确内容与规范化内容 SHA-256、文档版本、
  可选邻接行 SHA-256 和工作区相对路径。它只补充来源与重定位证据，不授权读取其他文件；较新、
  当前版本无法识别的 anchor 会被丢弃但不会导致整段对话不可读。
- “查找关联对话”只扫描加密状态中已发送 user message 的 context 快照，并要求相同 URI 与唯一
  内容关系；仅行号重叠不构成证据。命中后先切换权威会话，再以精确 `contextId` 发送
  `revealTurn`；问题轮次和对应上下文卡片持续强调，直到用户手动清除。
- 源码追踪不会调用工作区文件枚举或搜索；未在最近 user turn 明确附加的文件不会因回答文本而
  被打开。文件重命名或移动后，原 URI 反查可能失效，系统不会搜索工作区猜测替代路径。

### Notebook Cell 上下文

- Notebook 是 Cell-first 数据源，不是普通 JSON 文件。普通选区/当前文件入口会拒绝
  `vscode-notebook-cell:` 文档；即使 `.ipynb` 被强制作为普通文本打开，也会在调用
  `TextDocument.getText()` 前拒绝。系统文件选择入口同样拒绝 `.ipynb`；只有显式 Notebook 动作可以
  创建 Cell 上下文。捕获只调用已选 Cell 的 `TextDocument.getText()`，不读取或持久化 outputs、execution
  metadata、widget 状态、富 HTML、图片或 base64 数据。
- Cell 内存在非空文本选区时只捕获精确范围；否则捕获当前完整 Cell。Notebook 多选按 Cell 序号排序、
  去重，并在快照阶段共同执行最多 8 项、单项 40,000 字符、合计 60,000 字符的 Context Bundle 门禁。
  Code 与 Markdown Cell 都可附加，只有 Code Cell 显示 8 个代码任务快捷动作。
- `notebook/cell/title` 命令参数只能按对象身份解析为 Host 当前已打开 Notebook 中的真实
  `NotebookCell`；因此点击非活动 Cell 的按钮仍绑定被点击 Cell，而不会误用活动编辑器。伪造或过期
  的类 Cell 对象直接拒绝。Notebook toolbar 没有单 Cell 参数时才使用当前 Notebook 的明确选择。
- `NotebookSourceAnchorV2` 保存 Notebook 容器 URI/类型/版本、捕获时 Cell 序号、Cell 类型与语言、
  Cell 内范围、精确/规范化范围哈希、完整 Cell 哈希、相邻 Cell 哈希和可选工作区相对路径。虚拟
  `vscode-notebook-cell:` URI 不进入持久化；只有 `file`、`untitled`、`vscode-remote` 容器可成为
  Host 权威地址。
- 发送时每个 Cell 生成独立的合成源文件附件，例如 `analysis.cell-004.L3-L12.py` 或
  `analysis.cell-007.md`；未知语言降级为纯文本。可见问题仍只有用户问题，前端始终显示紧凑 Cell
  卡片；不存在 V2 anchor 的 `.ipynb` 上下文在 transport 层再次 fail closed，不能作为原始 JSON
  附件发送。
- 上下文卡片通过 `openNotebookDocument` / `showNotebookDocument` 打开 Host 保存的 Notebook，
  再以 `NotebookRange` / `revealRange` 定位 Cell 与 Cell 内范围。原索引只在 Notebook 版本和完整
  Cell 证据仍一致时使用；Cell 移动后必须由唯一内容及邻接证据重定位，重复 Cell 返回 ambiguous，
  删除或内容失配返回 stale/missing，均不得跳到第一个候选。
- 回答中的合成附件 `file:line`、Cell 内函数定义、上下文卡片回跳以及编辑器 Cell 选区反查对话，共用
  `conversationId + messageId/contextId` 的 Host 权威映射，形成四向 trace。Webview 不发送 Notebook
  URI，Host 不枚举其他 Notebook、工作区文件或隐藏输出寻找替代目标。

### 后台模型同步

- Webview 不维护硬编码模型清单。会话预热时 Host 在后台请求 `model.list`，Content Script 使用
  Chrome 中现有 ChatGPT 登录态读取网页自身的 `/backend-api/models`；它不是 OpenAI 公共 API，
  不需要 API Key，也不把认证信息传给 Relay 或 VS Code。
- Relay 将模型目录缓存 10 分钟并供多个 VS Code 窗口复用，因此打开本地模型菜单不再等待
  Chrome 页面操作。缓存只包含模型标签、说明和模型 slug。
- 默认挡位是 `Fast`；`Smart` 和各推理挡位仍由用户按会话显式选择。Host 在活动会话预热时解析
  默认或已选挡位，不把模型目录读取串行留到发送之后。
- 用户选择会携带点击时的 `conversationId`；Host 校验并持久化后回传权威状态，Webview 不保留
  可能错配会话的长期乐观值。
- `conversation.send` 携带本轮模型意图。一个 `document_start` 的 MAIN-world 小桥接器只改写
  ChatGPT 页面下一次自身 `/backend-api/conversation` 请求中的 `model` 字段，使用后立即清空；
  同一个一次性绑定还观察该 run 的请求和响应生命周期。它不自行发起对话请求、不读取问题，
  也不解析回答内容。模型意图未被页面桥接器确认时不发送问题。
- DOM 模型菜单保留为兼容回退，不再是正常路径；后台标签页即使延迟渲染 composer，也不会要求
  用户打开 Chrome 或展开模型控件。
- 空闲会话预先保存两次一致的完整历史指纹；发送时只需用一个新快照比对该指纹。若页面刚导航、
  历史仍在水合或预热尚未完成，仍回退到原有两次一致快照并 fail closed，不放松单次提交约束。
- 模型意图按本地会话写入加密记录，并在该会话下一次发送时使用。Relay 可以读取模型控件
  已挂载的收起状态和语义属性；读取模型目录时可从页面启动数据取得短生命周期访问令牌，但该
  值仅用于同源目录请求，绝不进入消息、缓存、日志、诊断或本地存储。扩展仍不读取 Cookie、
  网站存储、密码或账号资料。

## 上下文限制

- 最多 8 项；
- 单项内容最多 40,000 字符；
- 所有项内容合计最多 60,000 字符；
- 问题最多 20,000 字符；
- 所有上下文都不填入输入框，而是通过页面 `input[type=file]` 以内存 `File` 形式上传，不创建
  工作区文件或临时文件；
- 用户消息持久化 `contextTransportVersion` 收据：缺省值按旧版内联/附件规则恢复，版本 `2`
  按“纯问题 + 全附件”恢复，避免升级后把运输文本写回前端。
- 待发送上下文包含选区时，Webview 在 Composer 内显示 8 个静态代码任务快捷动作。点击只修改当前
  会话的本地草稿并聚焦输入框，不新增 Host/protocol 消息，也不自动发送、排队或打断；只有用户
  确认发送后，草稿文本才与仍封装的选区上下文一起进入既有发送链路。
- Notebook 多 Cell 中每个 Cell 单独计为一项；Code Cell 参与快捷动作可见性，Markdown Cell 不参与。

任一层超限均明确拒绝，不静默截断。Content Script 必须观察到每个附件文件名且发送控件
恢复可用后才提交，否则返回 `CHATGPT_ATTACHMENT_FAILED` 并 fail closed。可见 Prompt 不包含
本地 URI、工作区目录清单、未选择的编辑器内容、本地完整历史或隐藏系统策略。

## 会话存储

- 每个会话一个 AES-256-GCM v2 记录，AAD 绑定会话 ID。
- 会话加密主密钥可以保存在 VS Code `SecretStorage`；它只用于本地数据加密，不参与
  protocol v15 的 Chrome 连接。
- 多个 Extension Host 首次启动时，通过 `globalStorageUri` 中只含 PID/随机 token 的排他锁
  串行生成主密钥；写入后必须重新读取 SecretStorage 的规范值，锁文件绝不包含密钥材料。
- 写入前复制最近有效主记录作为备份，再以临时文件原子替换。
- 同一会话的保存、迁移和删除在宿主内串行执行；待写入内容在执行前快照。
- Chrome 的最小 tab/run 映射写入扩展自己的 `chrome.storage.session` 或
  `chrome.storage.local`。这些记录不包含 ChatGPT Cookie，也不读取网站 storage。
- tab 映射同时保存 `created | borrowed | legacy-unknown` provenance、单调 `leaseEpoch`、最近使用、
  空闲证明和用户接管时间；缺失新字段的记录只按保守默认值恢复。
- 删除和重命名只改变本地记录。删除可关闭插件创建的标签页，但不调用远端删除或重命名。
- 断线删除使用不含对话内容的关闭墓碑，重连后补发幂等标签页关闭命令。

## 多窗口与并发

- 一个 VS Code 窗口对应一个端口和 `instanceId`；Chrome 连接表按端口和实例隔离。
- 每个窗口的会话 ID 只在其 `instanceId` 路由内解释；相同会话 ID 不能跨窗口串线。
- Chrome 端最多三个会话同时生成；每个会话最多一个活动 run。
- 业务命令按会话串行，不同会话可并行；Stop 不应被其他会话的冷标签页阻塞。
- 关闭、重载或故障一个窗口时只断开该实例的 socket，不立即释放或关闭物理页面，以覆盖短时
  Reload；完成终态/逻辑删除仍按原协议收口。断开满 30 分钟后，只有经过完整证明的 Relay 自建
  空闲页才可由 GC 回收，其他窗口不受影响。

## 中断与恢复

- VS Code 或 Chrome 重启后通过原 `instanceId`、`conversationId`、`runId` 和 `remoteUrl`
  重新关联未完成任务。
- 用户触发 Relay Reload 时，Popup 必须先等待 Service Worker 把 Project 验证、tab/run 映射和
  canonicalization 证明写入短期一次性 local 检查点。新 Worker 只接受两分钟内且通过现有
  schema 解析的记录，恢复到 `storage.session` 后立即删除；写入失败时 Popup 不调用 Reload。
- 检查点不包含问题、回答、代码附件、Cookie 或账号信息；过期、畸形或引用已关闭标签页的
  记录在恢复时丢弃。
- Host 与 Relay 正常运行时版本应一致；更新先后顺序只允许相邻补丁版临时互连。跨两版及以上
  直接进入 `version-mismatch`，避免旧 Chrome 运行时代码伪装成健康连接。
- `WebviewView.visible` 只表示展示状态，不是传输开关；隐藏期间宿主继续接收并缓存状态。
- VS Code 主动发送 WebSocket ping 和应用心跳，Chrome Service Worker 心跳作为补充。
- 活动生成使用原 run 做非聚焦快照检查；页面从 discard/frozen 恢复时重新核对。
- MAIN-world 响应生命周期事件丢失、桥接失败或连接中断时，只允许在原 owned 标签页和原 run
  上调用 `content.recover` 并读取可见 DOM 快照；恢复路径不得再次发送 `conversation.send`、
  填写 composer 或重放问题。
- `generation.complete`、`generation.stopped` 等终态先写入 Relay 的持久 outbox；Host 将对应回答
  写入 AES-256-GCM 加密会话记录后，才按精确 `conversationId + runId + eventId` 返回 ACK。
  未确认终态只重放原 envelope，不能用无 run 归属的历史快照合成当前任务终态。
- 页面已完成且能确认 Markdown 时补发终态；无法确认发送状态时 fail closed，不自动重放
  问题。
- 10 分钟发送慢速提示；30 分钟结束本地 run，但保留标签页和远端 URL。
- 登录、CAPTCHA、页面权限或 selector 歧义会聚焦对应标签页，不改用其他后端。

## 真实登录态 smoke

- `pnpm smoke:live` 为每个模拟 Host 创建独立端口、`instanceId`、本地会话和测试标签页；每个
  run 只发送一次 `conversation.send`。
- run 未终止时，smoke 约每 5 秒发送一次合法的 Host→Chrome `relay.status.request` 保持连接并收集脱敏状态；不会重复发送
  `conversation.open` 或任何非幂等命令；终态或清理开始后立即停止探测。
- 终态判断只接受同一 `conversationId + runId` 的 `generation.complete` 或 `relay.error`，
  `conversation.snapshot` 只作为只读历史和诊断证据，绝不触发重发。
- 正常结果只包含版本、端口、计数、耗时和布尔值。失败时每个 run 最多记录 smoke 生成的
  `runId`、阶段、三类 generation 事件计数及最新快照的 `messageCount`、`tailRoles`、`complete`；
  不记录问题、回答、代码、标题、远端 URL、`conversationId` 或 `instanceId`。
- `finally` 清理覆盖成功、错误和超时；若 socket 已断开会进行有界重连，再发送
  `conversation.close(closeTab:true)`，并等待请求 ID 匹配的 `conversation.closed`；ACK 超时会
  有界重连后幂等重试。所有 smoke 创建的标签页都必须关闭；无法确认清理时返回非零结果，但
  绝不删除 ChatGPT 网站上的远端会话。

## Codex 式体验约束

- Webview 使用“任务工具栏 / 单栏消息流 / 底部一体化 Composer”结构和 VS Code 主题变量。
- 正常状态完全隐藏连接设施；短暂连接状态延迟显示为轻量行，失败才显示一个下一步操作。
- Ask2GPT 侧栏标题栏的选区动作常驻；Composer 左下角 `+` 也提供“当前选区”。选区、当前文件和额外附件都以紧凑卡片显示，发送前可预览、
  移除或切换，审阅浮层锚定在 Composer。
- Composer 尾部只有一个状态主按钮：空闲时 Send、生成且空输入时 Stop、生成且有输入时
  Queue 或“停止后发送”。默认行为来自 `ask2gpt.followUpQueueMode`，回车规则来自
  `ask2gpt.composerEnterBehavior`：配置的发送键仅为 Enter 或 Ctrl/Cmd+Enter；运行中固定以
  Ctrl/Cmd+Shift+Enter 反转单次 Queue/停止后发送行为，不增加并排的 Queue/Stop 按钮。
- 每次提交的 `clientRequestId` 会随队列项和晋升后的 user message 持久化。即使 Webview 未收到
  `sendResult`，权威状态也能精确结算同一草稿，不依赖文本相等猜测，也不会恢复并重复发送。
- 240px、320px 和 400px 下保持单栏，菜单、文件名、预览和操作按钮不越界。
- 流式 Markdown 只替换当前快照，不重新挂载整段消息或重播入场动画。
- `prefers-reduced-motion` 下关闭非必要动画和顺滑滚动，保留等价状态文本。
- 回答源码引用使用点状下划线、图标与真实按钮；反查轮次显示左侧追踪条和“匹配此选区”标签，
  同时强调精确命中的上下文卡片，并保持到用户手动清除；高对比与 reduced-motion 模式仍保留
  非颜色状态。

## 不可信边界与隐私

- Webview 消息、WebSocket 消息、Content Script 消息、持久化记录和 ChatGPT DOM 都是不可信
  输入。
- Relay 单帧上限为 2 MiB，并按 UTF-8 字节检查。
- Markdown 禁止原始 HTML 和危险 URL；远端图片只显示安全链接，不自动加载。
- Content Script 事件必须来自本扩展、顶层 `chatgpt.com` frame，并绑定实际
  `sender.tabId`。
- 日志和诊断只允许固定元数据，不记录问题、回答、代码、远端 URL、会话 ID 或
  `instanceId`。
- 扩展不读取 ChatGPT Cookie、网站 `localStorage`、`sessionStorage`、IndexedDB、密码或账号
  资料。模型同步允许读取网页自身模型目录及仅供该同源请求使用的短生命周期访问令牌；令牌不
  离开标签页、不持久化、不记录。MAIN-world 桥接器只消费一次性模型 slug 与本 run 的一次性
  生命周期绑定；它和增强后台调试通道都不读取请求正文，只解析本 run 的 assistant 响应文本。
  SSE 中的恢复令牌只作为不透明交接元数据跳过，WebSocket 只接受该 run 声明的 topic。原始响应
  字节不记录、不持久化；快照必须通过 run、tab、Project、大小和会话归属校验。

## 取消配对后的安全取舍

protocol v15 的 loopback 自动连接没有对端密码学认证。绑定 `127.0.0.1` 可以阻止局域网和
互联网直接访问，但不能抵御本机恶意进程：

- 本机进程可能抢先占用端口并冒充 VS Code 服务端；
- 本机进程可能尝试作为客户端连接 VS Code relay；
- 成功冒充可能看到待发送问题和显式附加代码，或诱导 Relay 操作 ChatGPT 页面。

因此任何 loopback 消息都不得触发 `chrome.runtime.reload()`。扩展重载只允许用户在 Relay
Popup 中明确点击“重新加载 Relay”；该动作只重启本地伴生扩展，不访问或修改 ChatGPT 会话。

固定 Chrome 扩展 ID、Origin、WebSocket subprotocol、协议版本、schema、方向、帧大小、
envelope ID 和 `instanceId` 校验可以减少误连接、远程页面滥用和跨窗口串线，但不能证明
对端进程身份。这是当前个人开发场景为降低安装和多窗口摩擦所采用的明确风险取舍。

需要抵御本机恶意进程时，应使用 Native Messaging、带操作系统 ACL 的本机 IPC，或其他
能够验证端点身份的方案，而不是 protocol v15 的零配置 loopback relay。
