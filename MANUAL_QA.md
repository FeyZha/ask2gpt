# Ask2GPT 0.1.3 — 人工验收

本清单针对 Relay protocol v15。验收前不要混用旧 VSIX 和旧 Chrome Relay。

## 构建、安装与同步升级

- [ ] 从不含 `node_modules`、`dist`、VSIX、ZIP 或旧版本归档的干净 checkout 执行
      `pnpm install --frozen-lockfile`、`pnpm audit:dependencies` 与 `pnpm verify`，全部通过。
- [ ] `pnpm package` 生成 `ask2gpt-0.1.3.vsix` 与
      `ask2gpt-relay-0.1.3.zip`。
- [ ] `pnpm verify:artifacts` 通过；Release 中两个安装包的 SHA-256 与
      `SHA256SUMS.txt` 一致。
- [ ] 根目录 `THIRD_PARTY_NOTICES.txt` 通过 `pnpm notices:check`；VSIX 和 Relay ZIP 都包含
      完全一致的第三方许可证声明，且同时保留 Ask2GPT 的 MIT `LICENSE`。
- [ ] 安装 `ask2gpt-0.1.3.vsix` 后执行 **Reload / 重新加载**；没有提示时运行
      `Developer: Reload Window`。
- [ ] 在 `chrome://extensions` 中加载 0.1.3 Relay 目录；升级时必须完整替换解压目录，禁止只覆盖
      `service-worker.js`、`content-script.js` 等个别文件，然后从 Chrome
      工具栏打开 Relay Popup 并点击“重新加载 Relay”（工具栏无入口时再使用扩展卡片的重载）。
- [ ] Popup 明确说明重载无需验证码，也不会删除或重命名 ChatGPT 会话。
- [ ] Chrome 中只保留一个 Ask2GPT Relay 开发者模式目录，扩展 ID 为
      `jieljndeocnmdlfbmfknfgglfaoneceb`。
- [ ] Activity Bar 和命令面板
      `Ask2GPT: 打开问答窗口 / Open Q&A` 都可以召唤视图并聚焦输入框；状态栏不再重复提供入口。
- [ ] 视图移动到 Secondary Sidebar 后仍能正确定位；运行 `View: Reset View Locations`
      可以恢复入口。
- [ ] v15 发布线内按任意顺序更新 VSIX 和 Relay 时，仅 `0.1.0` 起且产品补丁版本一致或相差 1
      的双端保持连接；正式安装仍要求同版。低于 `0.1.0`、相差两版及以上或跨出 `0.1.x` 时
      明确显示版本不兼容。同步更新并重载后恢复。
- [ ] 0.1.2 VSIX 连接仍在 rolling window 内的 0.1.1 Relay 时保持健康：Host 的
      `supportsTabLeases()` 为 false，`conversation.open` 不带 `purpose`，且不发送
      `conversation.release`；升级 Relay 至 0.1.2 后 capability 自动开启。反向组合（0.1.1 VSIX +
      0.1.2 Relay）也继续接受 legacy open，不把可选租约字段当作握手条件。
- [ ] 上述相邻 patch 组合只验收滚动升级，不验收二进制回滚。不得让 0.1.1 Relay 读取 0.1.2 已写入
      的 session/local 状态；需要恢复时重新加载同版 0.1.2 Relay，并人工确认 Chrome 中仍打开的页面。
- [ ] 版本不一致持续存在时，Relay 重试逐步退避到 30 秒，不以亚秒级频率刷连接与日志；
      同步更新后首次完整握手立即清零退避。
- [ ] Host 在 `relay.hello` 后拒绝产品版本时，Relay 仍显示明确的版本错误，不出现短暂“已连接”
      假象；来自伪造 loopback 服务的错误不得触发自动重载或任何 ChatGPT 操作。
- [ ] 从使用旧验证码/HMAC 配对机制的构建升级时，不要求输入旧验证码、清除 HMAC 密钥或执行
      双端配对重置；旧配对数据不参与 protocol v15 连接。

## 零配置 loopback 连接

- [ ] Chrome 已启动、Relay 已启用时，打开 Ask2GPT 后自动连接，无验证码、配对按钮、
      HMAC、信任码或 SecretStorage 配对步骤。
- [ ] 安装或 reload VS Code 后不打开 Ask2GPT 侧栏；Extension Host 启动完成即自动监听
      `127.0.0.1:32171–32180`，Chrome 自动握手，不依赖 `onStartupFinished` 是否被重放。
- [ ] 人为让首次监听失败一次后释放端口；Host 自动退避重试并恢复监听，无需打开侧栏或点击
      “重新检查”。在重试计时器存续时关闭 Extension Host，不留下计时器或孤立监听器。
- [ ] 正常连接时 Webview 不显示端口、实例 ID、连接卡片或“已连接”徽章，用户可以直接
      输入发送。
- [ ] 短于 800ms 的启动或重连不显示状态；持续连接中只显示一条轻量行内提示，不遮挡
      消息、不清空草稿、不提供多余按钮。
- [ ] Chrome 未启动或 Relay 被禁用时，只显示一个明确的恢复操作；启动或启用后点击
      “重新检查”可以恢复。
- [ ] 旧状态意外报告 `pairing-required` 时，Webview 不显示任何验证码，而是给出一个
      非破坏性的“重新连接”操作。
- [ ] 运行 `Ask2GPT: 检查 Chrome 连接 / Check Chrome Connection` 只触发重新发现，
      不删除会话、标签页映射或本地加密历史。
- [ ] 错误 Chrome Origin、错误扩展 ID、错误 WebSocket subprotocol、错误协议版本、错误
      消息方向和错误 schema 被拒绝。
- [ ] 单帧超过 2 MiB、重复 envelope ID 或目标 `instanceId` 不匹配时 fail closed。
- [ ] 脱敏诊断可以显示版本、端口、连接阶段和错误码，但不包含问题、回答、代码、远端
      URL、会话 ID 或 `instanceId`。

## 多 VS Code 窗口

- [ ] 同时打开两个不同工作区，每个窗口获得不同端口和 `instanceId`，两边都自动连接。
- [ ] 同一工作区同时打开两个 VS Code 窗口，确认它们租用不同存储槽位、端口和
      `instanceId`。
- [ ] 在全新配置中同时启动两个窗口并各自立即保存第一段会话；重载两个窗口后，两边记录
      都能解密恢复，SecretStorage 只生成一个主密钥，初始化锁中从未出现密钥材料。
- [ ] 在两个窗口中分别创建会话并同时提问，问题、标题、流式快照、Stop 和终态不串线。
- [ ] 在三个窗口中各启动一个回答，三个任务可以并行；第四个活动会话被明确拒绝。
- [ ] 关闭或 Reload 其中一个窗口，只重连该实例，其他窗口的 socket、标签页和回答不受
      影响。
- [ ] Chrome Relay Reload 后，所有打开的 VS Code 窗口分别恢复连接，不要求任何逐窗口
      人工操作。
- [ ] 在一个回答生成中点击 Relay Reload；按钮先显示保存状态，重载后原 tab/run 恢复，问题
      不重复提交，回答继续或从同一页面可见快照收口。
- [ ] 连续双击 Relay Reload 只产生一次检查点和一次重载；模拟检查点写入失败时不执行重载，
      原连接保持可用并显示明确错误。
- [ ] 注入过期或畸形重载检查点后启动 Relay；记录被删除，不恢复其中的标签、Project 或 run。
- [ ] VS Code 全部关闭后重新打开多个窗口，Chrome 按端口段发现每个实例；退避期间运行
      “检查 Chrome 连接”可以立即开始新扫描。
- [ ] 人为把同一 `conversationId` 放入两个实例路由，事件仍由 `instanceId` 隔离，不会
      进入错误窗口。

## 空白草稿与 Relay 标签页池

- [ ] 全新启动时记录活动空白草稿的本地 `conversationId`，不发送问题并连续执行三次
      `Developer: Reload Window`；每次恢复同一 ID，Chrome 中不新增 Ask2GPT Project 根页或会话页。
- [ ] 空白草稿尚未点击、聚焦或输入 Composer 时 Reload VS Code；草稿附件与本地会话身份保持且不
      创建 ChatGPT 页。点击、聚焦或开始输入 Composer 会触发 dispatch prewarm，可能在提交前分配
      页面；此时网页 composer 仍为空、问题未发送，Reload 后本地草稿与会话身份仍保持。
- [ ] 连续新建并切换 50 个从未发送、没有远端 URL 的本地会话，再 Reload VS Code；活动空白 ID
      稳定，Relay 不因被动预热创建 50 个标签页，也不出现重复 Project 根页。
- [ ] 依次让 50 个会话各完成一次短回答并切换到下一会话；每次 release 失败或 3 秒 ACK 超时都不
      阻塞切换与下一次发送。无保护条件时 Relay 复用最久未使用的自建空闲页，稳定受管池不超过三个；
      若某页无法证明安全，允许临时 overflow，但不得清空或抢占它，之后只在证明安全时收敛。
- [ ] 同时从三个 VS Code 窗口各启动一个真实回答，确认三个 Relay-created 页有互斥租约且并发运行；
      第四个活动 run 被既有三并发门禁明确拒绝。三个终态完成、落盘并 ACK 后，页面才可能进入空闲池。
- [ ] 在 Relay-created 页面留下未发送 composer 文本，分别附加一个文件、打开可见 modal、保留停止/
      响应控件；逐项确认 `content.inspectIdleState` fail closed，页面不会被 LRU 复用、Popup 清理或 GC
      关闭。清除状态后还必须重新通过唯一可见可写 composer、空文本和无附件证明。
- [ ] 先在 Chrome 打开一个与本地 `remoteUrl` 精确相同、且未被当前 Relay 跟踪的会话页，再恢复本地
      会话；Popup 将其计为 borrowed。切换、release、本地删除、Popup 清理与 GC 都不导航或关闭该页，
      删除只返回 `left-open` 并解除本地映射。
- [ ] 注入/保留升级前缺少 provenance 的 tab 记录并 Reload Relay；它只迁移为
      `legacy-unknown`。Popup 报告 legacy candidate，但自动 GC 和“清理安全闲置页”均不关闭；用户
      在 Chrome 标签栏确认后手动关闭。
- [ ] 检查 0.1.2 新采用的用户页以 `provenance: borrowed` 与 `owned: false` 成对持久化；在 0.1.2
      内切换、删除、Popup 清理与 GC 均不导航或关闭它。不要加载 0.1.1 二进制验证此项：跨版本
      状态回滚不受支持，也不得作为用户页安全边界。
- [ ] 点击一个 Relay-created 空闲页使其成为 Chrome 当前标签；它记录 `userClaimedAt` 并在 Popup
      显示为 protected。之后创建更多会话、等待 GC、执行安全清理都不复用或关闭该页；Relay 为发送
      进行的内部短时激活不能产生同样的用户接管标记。
- [ ] Popup 的 managed/active/reusable/protected、borrowed、legacy candidates 与软容量 3 是读取
      当时的状态快照/候选估算，不要求预计可清理数等于最终关闭数。点击“清理安全闲置页”后逐页
      二次执行 worker 与页面证明，只减少当时仍安全的 Relay-created 页面，并跳过 running、dirty、
      pinned、audible、active、user-claimed 及未知来源页。
- [ ] Host 保持连接并准备至少三个安全空闲自建页；等待 10 分钟后的一分钟周期 GC 只关闭 surplus，
      至少保留一个 warm page。关闭全部 VS Code Host 后，最终安全页在最后使用满 30 分钟前保持；
      满 30 分钟且再次通过空闲证明后才关闭。修改系统时钟、worker suspension 或错过 alarm 不得造成
      提前关闭；下一次唤醒按绝对时间重新判断。
- [ ] 在 release 后但终态仍在 outbox、终态历史屏障未清、canonicalization/快照同步/导航/预热/
      debugger/可见性租约仍存在的各阶段触发分配、Popup 清理和 GC；所有阶段都保持原页。只有精确
      终态落盘 ACK、全部屏障清除并通过页面空闲证明后才允许复用。
- [ ] Chrome Service Worker 普通 suspension/restart、Relay Popup 受控 Reload 和 VS Code Reload
      都保持 `provenance + leaseEpoch + lastUsedAt + idleSince + userClaimedAt` 的保守语义；无法恢复
      provenance 时降级为 `legacy-unknown`，绝不升级成 Relay-created。

## ChatGPT Project 与会话映射

- [ ] 未绑定时 Webview 明确显示 `Ask2GPT Project` 引导；允许保留问题草稿，但发送按钮
      和模型选择不可用，且 Chrome 不创建 `https://chatgpt.com/` 根页面会话。
- [ ] 在 Chrome 打开名为 `Ask2GPT` 的 Project 首页或其中任意对话后，Relay Popup 的
      “绑定当前 Project”显示成功；绑定必须由同一侧栏条目或受限目录数据中的精确名称证明，
      不能凭正文链接、页面标题、URL slug 或 Project-shaped URL 猜测；关闭 Popup、重载 Relay、
      重启 Chrome 后可信 `projectBindingV6` 仍直接可用。
- [ ] 旧 `projectBindingV5` 没有同一 scope 的严格证据时保持待验证且不可发送；核验成功后写入
      V6 并移除 V5。伪造正文、标题或其他 scope 均不得产生 V6。
- [ ] 已绑定 Project A 时，即使另一个同名 Project B 可见也不得隐式替换；只有用户在 Popup 中
      明确点击“重新绑定”并严格验证 B 后才允许切换。
- [ ] Project 位于另一个 Chrome 窗口且当前窗口没有 Project 时，唯一候选仍可绑定；同时打开
      多个不同 Project 时明确提示先切换，不会绑定随机候选。
- [ ] 只打开 ChatGPT 首页且侧栏可见 `Ask2GPT` 时可以直接发现并绑定；没有任何 ChatGPT
      标签页时，首次提问会新建后台首页、发现 Project、关闭临时页，再从 Project 根页创建
      会话。没有匹配 Project 时问题保持未发送，并聚焦该首页供用户处理。
- [ ] 折叠侧栏后仍能通过同一合法侧栏条目的可访问名称识别 Ask2GPT；图标节点或
      “Project/项目”后缀不会导致漏判，多个不同匹配仍会被拒绝。
- [ ] 绑定一次后同时打开多个 VS Code 窗口，每个窗口都直接使用同一 Project，不重复绑定。
- [ ] 每个新会话标签页都先打开绑定的 `https://chatgpt.com/g/.../project`，发送后 URL 保持为
      同一 scope 的 `https://chatgpt.com/g/.../c/...`。
- [ ] 页面意外跳到普通 `/c/...` 或另一个 Project scope 时返回
      `CHATGPT_PROJECT_MISMATCH`，停止同步且不自动重发问题。
- [ ] 升级前已映射的普通 `/c/...` 会话仍可恢复，但新会话绝不以普通根页为模板。
- [ ] 普通 `/c/...` 与 Project `/g/.../c/...` 都通过受支持 URL 校验；非
      `https://chatgpt.com`、非会话路由或畸形 URL 被拒绝。
- [ ] 新建会话时只管理 Ask2GPT 创建的标签页。
- [ ] 恢复会话时只接管与本地 `instanceId + conversationId + remoteUrl` 明确匹配的标签页。
- [ ] 在 ChatGPT 侧栏创建多个无关会话和 Project；Ask2GPT 不读取、枚举、导入或修改
      它们。
- [ ] 关闭已映射标签页后，下一轮仅通过该会话保存的 `remoteUrl` 恢复，不扫描侧栏寻找
      相似标题。
- [ ] 本地删除或重命名不删除、重命名或移动网站会话。
- [ ] 远端会话不存在、无权访问或 URL 身份不一致时明确失败，不自动重放本地历史。
- [ ] 首次从绑定 Project 根页发送时，即使回答 DOM 早于 `/g/.../c/...` URL 出现，也不会
      报 `CHATGPT_REMOTE_UNAVAILABLE`，最终回答正常落入当前本地会话。
- [ ] 首次发送依次出现临时 `/c/A`、首个流式快照，并在约 4 秒后切换到最终 `/c/B` 时，
      回答继续生成；快照、终态、历史和持久化映射最终都指向 B，且全程没有 relay error。
- [ ] 使用短回答复现 `snapshot(A) → complete(A) → 约 4 秒后 B`；回答在 complete(A) 时立即
      结束流式状态，随后同一 owned 标签页的完整可见快照把持久化映射更新为 B，不出现假忙。
- [ ] 使用更快的回答，让 complete 时页面仍停在根地址且 3 秒后仍无 `/c/...`；终态仍正常
      到达 VS Code，稍后出现 B 时由完整可见历史补齐 URL，不报远端不可用。
- [ ] 在 complete(A) 后立即追问或重新生成；即使 Host 缓存仍是 A，Relay 也保持当前 owned
      标签页 B，不把页面反向导航到 A，并把新请求发到当前会话。
- [ ] 让 B 的页面 DOM 或 Content Script 延迟 5–15 秒才可读取；Relay 保留标签映射并持续重验，
      一次读取失败不能解绑或报告 `CHATGPT_REMOTE_UNAVAILABLE`。
- [ ] 回答生成超过 30 秒后再从 A 跳转到 B；exact run 在整个生命周期内仍可采用 B。
- [ ] 在 A 上于首个回答 token 前点击 Stop，使远端快照只有 user 消息；本地停止状态立即完成，
      B 稍后仍可通过完整可见历史同步，下一轮正常发送。
- [ ] 在生成期间重载 ChatGPT 页面或 Chrome Service Worker；Content Script 通过可见 Stop 控件
      恢复当前 run 后仍保持 canonicalizing，随后的 A→B 不会被锁死或解绑。
- [ ] 分别让 owned 标签页保持 Chrome 当前选中、切到后台、再切回；这些显示状态都不改变
      会话所有权，流式、终态和 A→B 同样成功。
- [ ] 在正常（未最小化）的 Chrome 窗口中把 exact owned 标签页切到后台并选中一个无关用户标签页；
      发送追问时 Relay 只在原 home window 中短暂选择 exact owned 标签页，Chrome 窗口不抢系统焦点。
      追问只新增一条用户消息并正常完成；终态后恢复此前用户标签页，不创建用于发送的第二窗口。
- [ ] Relay Popup 首次使用时“增强后台接收”默认开启。把整个 Chrome 窗口最小化后发送长回答，
      VS Code 在终态前至少收到两个递增快照；原 home window 使用 Chrome 自己维护的 restore bounds、
      以 `focused=false` 临时恢复为 normal，exact owned 标签页在该 home window 中成为 active。过程中
      不提交完全离屏 bounds、VS Code 不失去系统焦点；终态后恢复原边界、此前 active 标签页和
      minimized 状态，不留下第二窗口。
- [ ] 在 Chrome 已经最小化时，从 VS Code 连续两次发送相同的短问题；每次都只新增一条用户
      消息并收到回答，第二次不会因旧的同文消息误判为已提交；每次运行都不弹到前台、不抢焦点，
      终态后原窗口仍保持最小化。
- [ ] 在后台标签页或刚恢复的最小化窗口中发送首轮和追问；Relay 必须先取得间隔 350 ms 的两次
      composer 就绪证明，再进入唯一一次 trusted-pointer 动作。不得因旧 DOM 短暂可见而留下未提交
      草稿或永久 busy run。
- [ ] 可见性租约期间从任务栏打开 Chrome 或主动切换标签页；回答结束后保留用户的新窗口状态和
      active 标签页，不再次最小化或覆盖用户选择。
- [ ] 明确关闭“增强后台接收”后，在 Chrome 已最小化时发送短问题；home window 仍按同一无焦点
      可见性租约完成提交，不出现抢占系统焦点的浏览窗口。发送使用短时 debugger 的唯一 trusted-pointer
      动作；只有持续流式网络捕获能力随该开关关闭。
- [ ] 分别在 Chrome 前台与最小化状态发送，均在同一次页面 MAIN-world 调用中验证 owned composer、
      发送按钮、可见区域和命中点唯一，并取得四次稳定几何样本。MAIN world 只返回命中点；Service
      Worker 在 home window 的 exact active tab 上派发一次 CDP 左键 move/press/release。不得从临时
      停放窗口发送，不得聚焦用户的 Chrome 窗口、调用页面 `click()`/`requestSubmit()`、派发键盘输入、
      执行备用激活或自动重试。按下或释放结果不确定时只能只读恢复。
      默认增强模式下，每次激活前须先把 exact owned renderer 的 lifecycle 设为 active 并启用页面焦点
      模拟；普通后台标签页和按浏览器 restore bounds 恢复的最小化 home window 均走同一路径，且不得
      切换操作系统窗口焦点。
      关闭增强后台接收时，可建立一个不启用 Network 域的短时 debugger 会话，仅完成该指针动作后
      立即断开。
      `scripting` 不可用、标记不唯一、按钮无效、几何异常或命中点被遮挡时必须在操作前失败；激活
      结果不确定时只能只读恢复，不得重试。仅出现 request-start 不得确认发送；必须观察到匹配的用户
      消息或 response lifecycle。故意吞掉该次提交时，约 1.5 秒后应提示草稿仍在输入框，不得误报
      “已显示本轮用户消息”；即使独立 `relay.error` 事件丢失，直接响应也必须释放活动 run 并返回
      同一脱敏错误码。
- [ ] 让 ChatGPT 的完整 HTTP 响应仅包含 `stream_handoff`，并让对应 WebSocket 首帧紧接
      `loadingFinished` 到达；VS Code 仍按顺序收到增量与 `[DONE]`，不提前 detach 或超时。
- [ ] 回答完成、停止或失败后，Chrome 的调试连接立即断开；另一个标签页或另一个 VS Code
      窗口的回答不会被当前 run 捕获。
- [ ] 用户明确关闭“增强后台接收”后，重载 Relay 仍保持关闭，Popup 明确提示最小化时流式
      内容可能延迟；再次开启后恢复上述后台流式行为。
- [ ] 在无活动 run 时，用户在同一个 owned 标签页内从 B 主动切换到会话 C；Relay 不导入 C、
      不改写 B 的绑定。重新选择本地会话或再次发送时，同一标签页恢复到 B。
- [ ] 新建第二个本地会话本身不建立后台页；首次发送时取得独占租约。若第一会话已 release、
      没有屏障且页面通过空闲证明，可用同一物理页导航到第二会话；否则使用另一页或安全 overflow。
      两个本地会话的远端 URL、历史和事件始终按 `instanceId + conversationId + leaseEpoch` 隔离。
- [ ] 用户关闭 B 的 owned 标签页后，重新选择该本地会话只按保存的 B URL 创建一个替代页；
      其他本地会话的标签页和映射保持不变。
- [ ] 完成上述 A→B 会话后，在同一本地会话继续提问；Relay 直接使用当前 B，回答正常完成。
- [ ] 在上述时序中提前触发页面预热/历史检查，不会把 owned 标签页从当前 B 导航回缓存 A。
- [ ] 错误 `instanceId`、`conversationId`、`runId`、非 owned tab、非 ChatGPT 域名或畸形快照
      仍被拒绝，不能修改 URL、标题或回答正文。
- [ ] `/c/...` 导航之后迟到的首页 `tabs.onUpdated` 事件被忽略，不删除新映射、不终止 run。
- [ ] 同时连接两个 VS Code 窗口并切换两个 owned 标签页的前后台状态；每个窗口只收到自己
      的标题、历史和 run 事件，关闭其中一个窗口不影响另一个。

## 标题与当前可见分支同步

- [ ] ChatGPT 为 Ask2GPT 创建或明确映射的会话归纳标题后，本地会话标题更新。
- [ ] 会话历史面板标题为“ChatGPT 同步会话”，并显示“尚未同步 / 等待同步 / 正在同步 /
      已同步 / 同步异常”之一。
- [ ] 后端提供 `titleSource=chatgpt` 时显示“ChatGPT 标题”；提供 `titleSource=local` 时显示
      “本地标题”；未提供字段时保持兼容推断。
- [ ] 本地改名不会反向调用 ChatGPT；再次收到当前映射会话的可见远端标题时按产品规则
      更新本地元数据。
- [ ] 在一个已映射会话中创建多个回答分支，只同步当前页面可见分支的用户/助手历史。
- [ ] 切换到另一可见分支后，下一次快照反映新可见分支；Relay 不枚举、合并或缓存所有
      隐藏分支。
- [ ] 其他 ChatGPT 标签页、侧栏条目、历史会话和未映射 Project 的标题变化不会进入
      Ask2GPT。

## 问答与恢复

- [ ] Ask2GPT 中选择的模型、用户消息、流式回答、标题和当前可见历史与映射的 ChatGPT
      网页会话一致；除工程执行能力外，不建立第二套问答语义或隐藏后端。
- [ ] 每个本地 `runId` 只产生一条 `conversation.send`；延迟确认、SPA 替换、断线重连、
      `content.recover` 和历史刷新都不会产生第二条命令或重复用户消息。
- [ ] 仅让原 composer 或 SPA 替换后的 composer 清空，但不出现本 run 请求生命周期、可见
      用户消息、Project 会话 URL、生成控件或新 assistant 节点时，发送仍不得被确认。
- [ ] 无上下文问题在 ChatGPT 页面只出现原始问题。
- [ ] 回答以 Markdown 流式显示，标题、列表、表格、链接和代码块结构正确。
- [ ] 围栏代码块显示语言栏和块内复制按钮；回答完成后关键字、字符串、数字、函数、类型、属性、
      变量、注释与 diff 增删使用可区分且符合当前 VS Code 主题的颜色。流式期间保持轻量渲染，
      完成时再切换为完整语法高亮，不出现闪烁或滚动跳动。
- [ ] Stop 只停止当前实例、当前会话、当前 run；Regenerate 只重新生成目标回答。
- [ ] 在 R1 的 Stop/排队指令仍在 Webview→Host 路上时让 R1 完成并启动 R2；迟到指令携带
      R1 的 `targetRunId`，不得停止 R2，也不得把追问错挂到 R2。
- [ ] 生成中输入追问时尾部仍只有一个主按钮：默认 Queue；将
      `ask2gpt.followUpQueueMode` 设为 `interrupt` 后显示“停止后发送”。后者先持久化一条
      追问，再停止精确 run，并仅在对应 stopped 终态落盘和 ACK 后晋升一次。
- [ ] 丢弃 Webview 的 `sendResult`，但正常投递包含 queue item 或同一 `clientRequestId` user
      message 的权威状态；15 秒后草稿不回弹，再次输入不会重复上一条。
- [ ] 一个冷标签页正在加载时，其他会话仍能发送，已运行会话仍能 Stop。
- [ ] 生成中 Reload VS Code，原 `runId` 的流式回答或终态能够恢复。
- [ ] 生成中 Reload Chrome Relay，任务被重新接管或明确 fail closed，不永久占用并发槽。
- [ ] 最大化/退出全屏 VS Code，并反复显示、隐藏 Primary/Secondary Sidebar；回答继续传输，
      恢复可见后显示最新快照。
- [ ] VS Code 完全遮挡 Chrome 一段时间，回答继续更新，或在页面恢复后通过当前映射标签页
      补齐。
- [ ] 连接中断时问题草稿和附件保持；无法确认是否已发送时不自动重复问题。
- [ ] 屏蔽或丢失 MAIN-world 的响应生命周期事件后，Relay 只在原 owned 标签页和原 run 上通过
      `content.recover` / 可见 DOM 快照恢复；不得重新发送 `conversation.send`、填写输入框或
      重放问题。
- [ ] 10 分钟显示慢速提示；30 分钟结束本地 run，但保留远端 URL 和标签页。

## 上下文与只读边界

- [ ] Ask2GPT 侧栏标题栏始终显示一个选区提问图标；Composer 的 `+` 始终包含“当前选区”。
      在文件、未保存文本或远程编辑器中选中内容后，编辑器右上角、右键菜单和命令面板同时显示
      “问 Ask2GPT（使用当前选区）”。清空选区后后三个入口消失，但侧栏入口保持可发现；不贡献
      CodeLens、行内提示、状态栏按钮或扩展快捷键。
- [ ] 点击任一选区动作后，Ask2GPT 被打开并聚焦；标题栏、右键菜单和命令面板动作在点击时
      捕获当前文档版本与精确选区，Quick Fix 使用其动作引用；结果显示在 Composer 上方的独立
      上下文卡片中，问题输入框保持为空且不会自动发送。
- [ ] 待发送上下文包含选区后，Composer 在附件卡下直接显示“解释这段代码、查找问题、修复报错、
      代码审查、重构、添加注释、编写单元测试、分析性能或安全问题”8 个动作；仅当前文件、普通文件
      或历史消息中的选区不显示该区域，选区不是第一项时仍只显示一组。
- [ ] 点击任一代码任务只填入当前会话的可编辑草稿并把焦点/光标移到输入框末尾，不自动发送、排队
      或打断回答；已有草稿原样保留并以空行追加，同一末尾任务不重复，选区源码、URI 和运输包装不
      展开进输入框。移除选区后动作区消失但草稿保留，切换会话时草稿不串线。
- [ ] 草稿达到 20,000 字符时点击快捷动作不截断或覆盖原稿，并给出辅助技术可读提示；中文、英文、
      240/320/400 px 侧栏和高对比模式下，8 个按钮均可 Tab 聚焦且不遮挡附件、输入框或发送按钮。
- [ ] 上下文卡片显示代码摘要、文件名和行号，可展开预览并可在发送前移除；操作不修改编辑器内容。
- [ ] 点击待发送或已发送上下文卡片主体会打开 Host 保存的 URI 并选中对应行；selection 内容整体
      移动后，精确快照唯一命中时仍定位新行，缺失时报告 stale、重复时报告 ambiguous，均不得静默
      跳到旧行或第一个匹配。整文件允许用 raw/normalized hash、唯一原文或唯一邻接行锚点重定位；
      文件不存在、证据缺失或范围歧义时保留卡片并明确提示。
- [ ] Host 只为每条回答前最近一条 user turn 的附件派生点击提示。该附件内可证明的
      `06_vector_store.py:34`、`:34-40`、`#L34-L40` 显示为可键盘操作的源码按钮；更早轮次、无附件
      回答、未附加文件、HTTP 链接、代码围栏和路径穿越保持普通文本且不得打开。
- [ ] 整文件外部插行后，回答行号通过唯一快照/锚点换算到新位置；原位替换、内部插删或重复候选且
      无法由唯一邻接锚点证明时报告 stale/ambiguous 并保持提示可见，不得仅因旧行号仍在范围内就打开。
- [ ] 回答中的已附加函数引用（如 `get_embeddings_endpoint()`）可点击并高亮定义名称；单定义直接
      打开，多定义使用 QuickPick，取消不改变状态；Document Symbol 与无语言服务时的快照回退都
      不得落到最近 user turn 所附选区证据之外。
- [ ] 在编辑器选中曾发送的代码后，编辑器标题栏、右键菜单或命令面板的“查找关联对话”可反查轮次：
      只有相同 URI 且精确或唯一包含的内容证据可入选，单纯行号重叠不得入选；单匹配直接定位，多匹配
      按相关度/时间显示 QuickPick，零匹配可选择“使用此选区提问”。归档对话需确认恢复。
- [ ] 反查定位后侧栏滚动到精确 user turn，持续显示“匹配此选区”并只强调命中的 context 卡片；
      滚动、状态刷新或普通等待不清除标记，只有用户点击清除按钮或目标记录消失才结束强调。
- [ ] 捕获 selection、current-file 和 file 上下文时写入 `SourceAnchorV1`，包括精确/规范化内容 SHA-256、
      文档版本及可用的邻接行 SHA-256；保存并 Reload VS Code 后这些元数据仍随加密会话恢复。
- [ ] 重命名或移动已附加文件后，原 URI 的上下文打开与“查找关联对话”允许明确失败；不得枚举或搜索
      工作区、按同名文件猜测新 URI，且失败不改变编辑器内容或对话状态。

### Notebook Cell 上下文

- [ ] 使用 VS Code Notebook/Jupyter 编辑器打开
      [`examples/ask2gpt-tour/notebook-tour.ipynb`](./examples/ask2gpt-tour/notebook-tour.ipynb)。Code Cell
      标题栏显示“附加 Cell”与“查找关联对话”，Notebook 工具栏显示附加入口，命令面板与 Composer
      `+` 也能找到 Notebook Cell 动作；普通文本编辑器入口和原有选区入口不消失、不重复。
- [ ] 在 Code Cell 内选中精确代码并点击 Cell 标题栏动作；侧栏打开并显示
      `notebook-tour.ipynb · Cell N · Python · Lx–Ly · 未包含输出`，问题输入框保持为空。清空文本选区
      后再次触发会附加当前完整 Cell，不偷偷切换为普通“当前文件”或读取 `.ipynb` JSON。
- [ ] 保持 Cell A 为活动编辑器，再直接点击 Cell B 标题栏的“附加 Cell”和“查找关联对话”；两项操作
      都只绑定被点击的 Cell B。A 中的文本选区不得泄漏到 B，B 不是活动文本 Cell 时按完整 Cell 捕获。
      传入伪造/过期的类 Cell 参数时明确拒绝，不能回退到 A 或 Notebook 当前选择。
- [ ] 选择连续及非连续的多个 Code/Markdown Cell 后，从 Notebook 工具栏和 Composer `+` 分别附加；
      每个 Cell 只出现一次并按 Notebook 顺序排列。Code Cell 显示 8 个代码任务快捷动作，只有 Markdown
      Cell 时不显示这些代码专用动作，点击快捷动作仍只填草稿、不自动发送。
- [ ] 发送前预览只包含 Cell source。为样例 Cell 添加文本输出、traceback、execution metadata、HTML、
      图片、widget 状态和一段明显的 base64 标记后重新附加；卡片预览、ChatGPT 可见问题、附件内容、
      加密会话记录与诊断都不得出现这些输出或元数据。发送附件名应类似
      `notebook-tour.cell-004.L3-L12.py` / `notebook-tour.cell-007.md`，而不是 `.ipynb`。
- [ ] 使用“重新打开编辑器方式 / Reopen Editor With”把 `notebook-tour.ipynb` 强制作为普通文本打开，
      分别尝试附加文本选区和“当前文件”；两项都在读取/生成预览前明确要求使用 Notebook Cell 动作，
      不产生上下文卡片。系统文件选择器选择同一文件也必须在 `openTextDocument` 前拒绝。构造/恢复
      缺少合法 `NotebookSourceAnchorV2` 的 `.ipynb`
      context 时，transport 再次以 `NOTEBOOK_RAW_CONTEXT_UNSUPPORTED` fail closed，页面不得出现附件。
- [ ] 单个 Cell 超过 40,000 字符、所选 Cell 超过 8 个、多个 Cell 合计超过 60,000 字符时均在发送前
      明确拒绝且不截断；恰好位于限制内时正常附加。每个 Cell 单独计为一个 Context Bundle 项。
- [ ] 打开 Cell 动作后、真正捕获前修改 Notebook 或 Cell；旧 click-time reference 返回
      `NOTEBOOK_CELL_STALE`，不得读取修改后的 Cell、回退到当前 Cell 或另一个 Notebook。未保存、
      `untitled` 与 `vscode-remote` Notebook 仍按各自容器 URI 工作，其他 scheme 明确拒绝。
- [ ] 发送一个 Code Cell 后插入/移动其他 Cell，再点击待发送或已发送上下文卡片；内容与邻接证据唯一
      时使用 `openNotebookDocument` / `showNotebookDocument` 回到正确 Cell 和 Cell 内行范围。复制出
      两个同内容且无法消歧的 Cell 时报告 ambiguous，删除或改写目标时报告 stale/missing；均不跳到
      第一个候选或旧索引。
- [ ] 在回答中点击 `notebook-tour.cell-NNN.py:line`，可回到该附件对应的 Cell 内行；点击回答引用的
      Cell 内函数名可高亮其定义。未附加的 Notebook 文件、越界行、早于最近 user turn 的附件别名和
      伪造 `vscode-notebook-cell:` URI 保持普通文本或明确拒绝。
- [ ] 在 Notebook Cell 中重新选择已发送的源码并运行“查找关联对话”，可定位精确 user turn 与唯一
      context 卡片；相同范围位于不同 Cell 时以 Notebook 容器、Cell 指纹和内容证据区分。完成卡片→
      Cell、回答行号→Cell、回答函数→定义、Cell 选区→对话四条 trace 后手动清除强调。
- [ ] 保存并 Reload VS Code，确认 V2 anchor 原样恢复且持久化记录不含 `vscode-notebook-cell:` URI。
      修改 `formatVersion`、Notebook URI、Cell/范围哈希或添加未知字段的记录后 Reload，损坏 anchor
      被丢弃/隔离但整段对话仍可读，任何定位操作都不得获得更宽读取权限。

- [ ] 新建会话或首次进入待发送草稿时保持空白；即使活动编辑器有选区，也不得自动附加选区
      或当前文件。
- [ ] 用户通过 Ask2GPT 侧栏/编辑器/Notebook 动作、黄色灯泡 Quick Fix 或输入框 `+` 显式添加的上下文立即
      可见，显示文件名、语言、行号、字符数、未保存状态和“封装为代码上下文”；发送前可以预览和移除。
- [ ] 移除上下文后，本草稿保持无上下文；编辑器焦点、选区、光标或文档变化不得偷偷恢复附件。
- [ ] 用户可以在当前选区和当前文件之间切换；切换主上下文槽是替换而非叠加，明确选择的其他
      文本文件仍作为额外附件保留。
- [ ] 待发送上下文按会话草稿独立保存。切换会话再返回后恢复原附件和移除状态，任何上下文
      都不得跨会话串入。
- [ ] 没有活动文本编辑器，或显式选择的是敏感、二进制、超限内容时，附加操作给出简短原因，
      但普通无上下文问答仍可发送。
- [ ] 选区为空或活动编辑器不是 `file`、`untitled`、`vscode-remote` scheme 时，侧栏标题栏和
      Composer 入口仍可见，但点击后明确提示先选择代码；编辑器范围入口不显示。旧引用或失效文档
      版本必须明确拒绝，不得隐式回退到当前文件或读取另一个编辑器。
- [ ] Composer 左下角 `+` 在无附件和已有附件时都存在。
- [ ] 通过侧栏/编辑器 Ask2GPT 动作或输入框 `+` 添加的当前选区、当前文件和明确选择的多个文本
      文件可追加到同一个 Context Bundle。
- [ ] 取消文件选择不改变已有附件；重复快照去重；每项可独立移除。
- [ ] 发送前的上下文审阅显示完整附件详情；已发送消息的紧凑卡片常显文件名和行号，展开后显示
      字符数、未保存状态、封装说明与快照预览，超过两项时以 `+N` 收起。
- [ ] 工作区内文件显示相对路径；工作区外文件不泄露父目录。
- [ ] 无论选区大小，ChatGPT 输入框和用户问题正文都只包含人类输入的问题；页面以同名代码文件
      胶囊封装每个上下文。附件内容与发送时快照完全一致，过程中不创建工作区文件或临时文件。
- [ ] 文件上传未完成、被 ChatGPT 拒绝或无法确认附件卡片时返回
      `CHATGPT_ATTACHMENT_FAILED`，页面不点击发送；本地问题与封装上下文保留并可明确重试。
- [ ] 可见问题正文不包含本地 URI、目录清单、未选择文件、隐藏系统策略或本地完整历史。
- [ ] 附件审阅浮层具有高度上限和独立滚动，不推挤消息或遮挡“回到底部”。
- [ ] 发送时原子锁定当前可见上下文；等待模型或远端会话准备期间不能出现“界面已移除、实际
      仍发送旧快照”的竞态。
- [ ] 发送成功后当前 Context Bundle 进入已发送消息，输入区附件全部清空且不会自动重新挂回；
      发送失败时问题草稿、附件、默认/手动来源及移除状态完整恢复。
- [ ] 显式读取只限用户从侧栏标题栏、编辑器标题栏、右键菜单、命令面板或黄色灯泡主动触发的
      “问 Ask2GPT（使用当前选区）”动作，用户从 `+` 选择的当前选区/当前文件，以及 Notebook
      Cell 标题栏、Notebook 工具栏、命令面板或 `+` 的显式 Cell 动作；无选区/Cell 时动作不读取任何
      内容，也不扫描、搜索、读取或上传工作区其他内容。
- [ ] 敏感文件、二进制、单项超过 40,000 字符、超过 8 项、总内容超过 60,000 字符、问题
      超过 20,000 字符时明确拒绝且不静默截断。
- [ ] “帮我修改并运行测试”“解释如何修改这个算法”等普通编码请求都走同一条 Relay 发送链路，
      不再被本地关键词或意图分类器拦截。
- [ ] Relay 只传递聊天与用户显式附加的代码上下文；本地扩展不会自行执行修改、运行、提交、推送
      或部署操作。

## Cookie、网站存储与权限

- [ ] Chrome manifest 只申请 `tabs`、`storage`、`alarms`、必需的 `debugger` 与 `scripting`；
      `scripting` 仅用于已验证 owned 标签页的内容运行时恢复和受限 MAIN-world 动作；不申请
      `cookies`、`history`、`downloads`、`nativeMessaging`、文件 URL 或剪贴板权限。
- [ ] Content Script 和 Service Worker 不读取 ChatGPT Cookie、网站 `localStorage`、
      `sessionStorage`、IndexedDB、密码或账号资料；模型目录请求所需短生命周期访问令牌只在
      标签页内使用，不进入 Relay 消息、日志、诊断或存储。
- [ ] `chrome.storage` 只保存扩展自己的最小 tab/run 映射和恢复状态；记录中没有问题、回答、
      代码、Cookie 或网站 storage 内容。
- [ ] DevTools 中观察普通聊天和 Project 聊天，确认模型目录只请求
      `https://chatgpt.com/backend-api/models`，MAIN-world 桥接器只改写下一次页面自身的
      `/backend-api/conversation` 模型字段，不自行发送额外对话请求。
- [ ] 对每个待发送 run，MAIN-world 桥接器只关联下一次 ChatGPT 页面自身的会话请求，并报告
      生命周期及当前 assistant 快照；不会关联其他 run，也不读取请求正文。
- [ ] 增强后台通道只匹配 owned 标签页中本 run 的 `text/event-stream` 响应；遇到
      `stream_handoff` 时只消费其中声明的 `conversation-turn-*` WebSocket topic，忽略共享连接
      上的其他 topic，只转发经过大小和归属校验的 assistant Markdown；不记录原始 SSE/WS
      字节、Cookie、恢复令牌或网站 storage。

## 会话存储与 UI

- [ ] 重启 VS Code 后本地完整历史恢复，扩展私有存储中看不到问题或代码明文。
- [ ] SecretStorage 只用于本地会话加密主密钥，不存在 Chrome 配对密钥用途。
- [ ] 新建空会话的初始页直接显示最近三条已有会话、相对时间与“查看全部”，点击可切换；
      没有历史时显示安静的空状态，不出现大段宣传内容。
- [ ] 无论会话是否完成预热、Chrome 是否已连接，模型菜单都立即显示“智能、极速、中、高、极高、
      Pro”六个网页挡位并默认选中“极速”；打开菜单不触发目录请求，也不显示加载状态。
- [ ] 选择挡位后 VS Code 标签在当前点击内立即变化，不显示“准备模型”或同步状态，也不操作
      ChatGPT 页面；用户可以继续输入，不需要等待。
- [ ] 已有远端 URL 或可见历史的活动会话空闲时预热账户模型目录和两次一致的完整历史指纹；健康
      预热后的发送只增加一次新历史检查，并与 debugger 附加并行。纯空白草稿不预热、不创建页。
      冷启动或历史变化时回退到两次稳定检查；切换失败时问题不得提交，成功时 ChatGPT 收到的模型
      与前端所选挡位一致。
- [ ] 人为阻塞首个回答后的 `chrome.storage.session.set`，首个非空快照仍先到达 VS Code；解除
      阻塞后恢复提示完成持久化，Relay 重启仍可只读恢复且不会重复发送。
- [ ] 发送前模型意图与问题属于同一请求；一次性意图只影响下一次 ChatGPT 页面请求，无法确认
      时不发送问题，前端保留用户选择以便处理账户权限或网页异常后重试。
- [ ] 深色、浅色、高对比度及 240px、320px、400px 窄侧栏可用。
- [ ] 正常状态不显示连接设施；失败行、上下文菜单、附件摘要和浮层不越界。
- [ ] 菜单、浮层、附件和生成状态使用克制短动画，不产生布局跳动或闪屏。
- [ ] 流式 Markdown 替换快照时不重播入场动画、不抢走滚动位置。
- [ ] 长历史和大附件下持续生成时，Webview 只接收当前回答轻量更新，输入和滚动保持响应。
- [ ] `prefers-reduced-motion` 下关闭非必要动画和顺滑滚动，状态文本与键盘操作正常。
- [ ] 键盘可打开上下文菜单、逐项浏览、预览、移除和关闭，焦点回到原触发按钮。
- [ ] `composerEnterBehavior=enter` 时 Enter 发送；`cmdIfMultiline` 时单行 Enter 发送、多行需
      Ctrl/Cmd+Enter；`cmdAlways` 时仅 Ctrl/Cmd+Enter 发送。Shift+Enter、Alt+Enter 与中文输入法
      组词期间 Enter 不误发；运行中始终以 Ctrl/Cmd+Shift+Enter 只反转本次 Queue/停止后发送
      行为，Ctrl/Cmd+Enter 仍严格服从已配置的发送规则。
- [ ] 回答中的 `javascript:`、原始 HTML 和远端图片不会执行或自动加载。

## 真实登录态 smoke

- [ ] 运行：

  ```powershell
  pnpm smoke:live -- --host-count 3 --connection-timeout-ms 180000 --generation-timeout-ms 180000
  ```

- [ ] 首轮三个 Host 真正并发，且每个 run 只观察到一条 `conversation.send`；主 Host 的第二轮
      能从同一远端会话验证完整历史。
- [ ] 对持续超过 5 秒的活动 run，约每 5 秒只出现一次合法 `relay.status.request`；它没有
      `conversationId` 或 `runId`，不填写 composer、不发送问题，并在 run 终止或清理开始后停止。
- [ ] smoke 只把同一 `conversationId + runId` 的 `generation.complete` 或 `relay.error` 当作
      终态；只读 `conversation.snapshot` 不能结束 run 或触发重发。
- [ ] 生成终态先持久进入 Relay outbox；Host 加密落盘回答后才 ACK。屏蔽首个终态帧或 ACK 后，
      同一 `eventId` 可幂等重放，且旧会话快照不能结束当前 run。
- [ ] 成功输出只包含版本、端口、计数、耗时和布尔结果。构造失败后检查每个 run 的诊断只含
      smoke 生成的 `runId`、阶段、`generation.snapshot` / `generation.complete` /
      `relay.error` 计数，以及最新快照的 `messageCount`、`tailRoles`、`complete`。
- [ ] smoke 输出和错误诊断都不包含问题、回答、代码、标题、远端 URL、`conversationId`、
      `instanceId`、附件内容或账号信息。
- [ ] 分别验证成功、Relay 错误和超时路径：smoke 都自动关闭自己创建的测试标签页；清理时
      socket 断开会有界重连。无法关闭任一测试标签页时命令以非零结果明确失败，但远端网站
      会话仍保留。

## protocol v15 本机冒充风险确认

- [ ] 安装文档和诊断说明明确：连接只监听 `127.0.0.1`，但 v15 没有验证码、HMAC 或共享
      密钥，不能认证对端本机进程。
- [ ] 团队确认 MVP 接受“本机恶意进程可能占用端口或冒充对端”的风险，不把 loopback
      等同于安全身份认证。
- [ ] 协议版本、固定扩展 ID、Origin、subprotocol、schema、方向、帧上限、envelope ID 和
      `instanceId` 校验仍启用，并明确这些措施不能抵御拥有本机执行权限的攻击者。
- [ ] 需要抵御本机恶意进程的部署不使用本 MVP；后续方案应评估 Native Messaging 或带
      操作系统 ACL 的本机 IPC。
