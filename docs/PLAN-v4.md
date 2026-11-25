# 复听 Takecut v4 重构计划

## Context

v3 能用，但已经撑到头了：

- **代码**：`web/app.js` 一个文件 590 行，全是全局变量。时间轴换算、建议规则、播放、绘制、导出都搅在一起，我刚修的 3 个 bug 都出在这种耦合上，而且没有任何测试。
- **项目会丢**：导入的录音放在临时目录，重启服务就没了。
- **只有中文**：界面只有中文，转录语言写死 `zh`。评委多半会用英文录音来试，现在会转出乱码。
- **吃内存**：每次剪辑都重建整条音频，15 分钟立体声要占约 0.6 GB。
- **功能缺口**：没有重做；Whisper 听错的字没法改，字幕会带错；只能导出 WAV；建议只有「相同开头的重录」和「叠词」两种。

目标：重建成结构清楚、有测试、中英双语、更好看也更顺手的本地剪辑台，核心是参考同类产品的「一键清理」流程。

已确定：

- v4 在 `v4` 分支开发，v3 继续留在 main 上公开。
- MYT 11/27 20:00 冻结：测试全绿、走查通过就合并进 main 作为 Devpost 版本；否则交 v3。
- 以音频为主，视频放进 P2。

保持不变：

- 只在本机运行，服务只听 `127.0.0.1`。
- 双击 `start.cmd` 就能启动，前端不需要构建工具，可离线使用。
- 后端用 Python 标准库 HTTP 服务加 faster-whisper。

## 参考了谁，借鉴什么

| 参考 | 借鉴 |
| --- | --- |
| Descript | 「Remove filler words」、「Shorten word gaps」（逐个预览或一次全缩短）；改字幕文字不动音频 |
| Gling | 自动找出坏 take 和停顿，再让人逐条确认或恢复 |
| 剪映「智能剪口播」 | 一次识别无声停顿、语气词、重复句；剪气口时保留 0.2–0.5 秒呼吸感 |
| Premiere Pro 文字剪辑 | 逐字稿面板，批量找停顿和语气词 |
| DaVinci Resolve | 已有的 I/O、波纹删除键位；FCPXML 作为导出目标 |
| Audapolis、Rescript、Coalesce（开源） | 用 faster-whisper 做本地文字剪辑 |
| Auphonic | 响度标准化目标：播客 −16 LUFS，视频 −14 LUFS |

## 功能清单

### P0：冻结前必须完成

1. **一键清理面板**（右侧，对应草图）。分四类，每类显示数量，可以逐条处理（▶ 试听、✓ 应用、✕ 忽略），也可以一次全部应用。
   - **重录 v2**
     - 判断方式从「相同开头」改为相似度（LCS 比例）加时间窗口。
     - 能识别同一句里的抢跑，例如「今天我想今天我想聊聊」。
     - 默认推荐最后一遍完整的 take；如果最后一遍明显偏短，就推荐最长的一遍。
     - 按 1–9 试听对应的遍数，Enter 保留。
   - **叠词和口吃**：沿用 v3 的规则，加上英文的半截重复，例如「th- the」。
   - **语气词**
     - 按语言分强弱。强：嗯、呃、额、唔 / um、uh、er。弱：那个、就是、然后 / like、you know。弱语气词只有前后有停顿或标点时才标出。
     - 给 Whisper 加 `initial_prompt`，让它保留语气词。
     - 有声音却没有对应文字的片段，标成「可能的语气词或呼吸」。
   - **长停顿**
     - 默认阈值 0.8 秒，可以调。
     - 用后端的能量分析校准真实静音段。
     - 「缩短到 X 秒」只剪掉静音中间那段，保留环境底噪，听起来更自然。
2. **项目持久化和首页**
   - 项目存到 `%LOCALAPPDATA%\Takecut\projects`，重启后还在，可以删除，自动保存。
   - 首页列出最近项目，显示时长和已剪比例。
   - 内置中文示例和新的英文示例。
3. **中英双语界面，加转录语言选择**：中文 / English / 自动。
4. **改字**
   - 双击词就能改，只改字幕，不动音频，支持全部替换。
   - Whisper 把握低的词加虚线下划线，提醒你核对。
5. **撤销和重做**：Ctrl+Z / Ctrl+Shift+Z。操作后弹提示，里面带「撤销」按钮。
6. **导出对话框**
   - 音频：WAV / MP3 / M4A，由服务端 FFmpeg 渲染。
   - 响度标准化：关 / −16 / −14 LUFS。
   - 轻度降噪（`afftdn`），默认关。
   - 字幕：SRT / VTT / TXT。可设每条字数上限、去掉句尾标点、简体 / 繁体（装了 OpenCC 才有）。
   - 音频和字幕用同一份剪辑表。
7. **新界面**（按草图）
   - 浅色和深色主题，内联 SVG 图标。
   - 选中文字时出现浮动工具条：试听、剪掉、改字、插气口。
   - 播放时逐字稿自动跟随。
   - 按 `?` 显示快捷键说明。
   - 加空状态提示，整页都能拖入文件。
8. **智能剪点**：按词剪时，两端自动吸附到 ±60 ms 内最安静的位置，接缝更干净。仍然保留 3 ms 淡化。

### P1：P0 稳定后再做

9. **模型设置**：small（CPU int8）/ large-v3-turbo（CUDA float16）。自动检测 GPU，失败就退回 CPU。这台电脑是 RTX 5070，turbo 已经缓存好了。
10. **波形改进**：总览小地图；Ctrl+滚轮缩放；拖动平移；剪后 / 原始视图切换；选区吸附到词边界。
11. **逐字稿搜索**（Ctrl+F）：可以一次剪掉或改正所有匹配项。
12. **导出 FCPXML 给达芬奇**：每段保留的音频成为一个片段。需要你在 Resolve 里验证。
13. **试听倍速** 1.25× / 1.5×（会变调，界面里注明）。

### P2：截止后或有余力再做

14. MP4 导入、同步预览、MP4 导出。
15. 用本地 multilingual-e5-small（ONNX）做语义相似度，找出改写过的重录。
16. 打包成 Windows exe，不用装 Python。
17. 可选的云端 LLM 功能，例如生成章节和标题，默认关闭。

## 架构

### 后端：`takecut/` 包，继续用标准库 `http.server`

- **`__main__.py`**
  - 用 `py -3 -m takecut --open` 启动，参数有 `--port` 和 `--data-dir`。
  - 根目录的 `server.py` 改成 3 行转发，`start.cmd` 和旧说明照样能用。
- **`app.py`**
  - 负责路由、静态文件，媒体文件支持 HTTP Range。
  - 沿用 v3 `Handler.valid_host` 的 Host 检查，写操作仍要带 `X-Takecut` 头（`server.py:69-143`）。
- **`projects.py`**：每个项目一个目录 `projects/<id>/`，里面放 `project.json`、`audio.wav`、`words.json`、`analysis.json`、`edits.json`、`exports/`。写入先写临时文件再替换；id 只接受 uuid hex。
- **`jobs.py`**：单个后台线程排队跑转录和导出，带进度。替换 v3 的 `BUSY` 锁和 `JOBS` 字典。
- **`transcribe.py`**：从 v3 的 `transcribe()`（`server.py:26`）抽出来，新增：
  - 可选模型、设备和语言；
  - 按语言设置 `initial_prompt`，保留语气词、偏向简体；
  - 开启 `vad_filter`，设置 `condition_on_previous_text=False`（减少 Whisper 自己编出来的重复句）；
  - 保存每个词的 `probability`；
  - 需要时用 OpenCC 繁转简。
- **`analyze.py`**：用 numpy 算 RMS 包络（10 ms 一帧），得到：
  - 静音段和底噪；
  - 有声音没文字的片段；
  - 每个词边界附近最安静的点，供智能剪点用。

  结果存进 `analysis.json`。
- **`render.py`**：把剪辑表转成 FFmpeg `filter_complex`。
  - 每段用 `atrim` 截取，两端加 `afade` 3 ms；
  - 气口用 `anullsrc` 生成静音；
  - 用 `concat` 拼接；
  - 可选两遍 `loudnorm` 和 `afftdn`；
  - 编码成 wav / mp3 / m4a。
- **API**：
  - `GET /api/system`
  - `GET` / `POST /api/projects`
  - `GET` / `DELETE /api/projects/{id}`
  - `PUT /api/projects/{id}/edits`
  - `GET /api/projects/{id}/audio`（支持 Range）
  - `POST /api/projects/{id}/transcribe`
  - `POST /api/projects/{id}/export`
  - `GET /api/jobs/{id}`
  - `GET /api/projects/{id}/exports/{name}`

### 前端：ES modules，不用构建工具

- **`web/js/core/`**：纯函数，不碰 DOM，用 `node --test` 做单元测试。逻辑从 v3 搬过来：
  - **`timeline.js`**
    - 来源：`joinCuts`（`app.js:28`）、`keepRanges`（`:39`）、`rebuildAudioPlan`（`:48`）、`mapped`（`:74`）、`sourceTime`（`:369`）、`pauseAnchor`（`:296`）。
    - 改成以 `{duration, sampleRate, cuts, pauses}` 为输入的纯函数。
    - 保留这次修好的行为：气口锚点在合并剪段后再算，剪段和气口按采样帧比较。
  - **`edits.js`**：剪辑动作，包括剪掉、保留某遍、设气口、改字、忽略建议。
  - **`history.js`**：撤销和重做。
  - **`lines.js`**：来自 `splitLines`（`:82`），按中文逐字、英文按空格分词处理。
  - **`suggest/{retakes,stutters,fillers,pauses}.js`**：拆分并升级 `findSuggestions`（`:95`）。
  - **`subtitles.js`**：来自 SRT 导出（`:512`），加上 VTT、TXT 和各项选项。
  - **`text.js`**：来自 `normalized`（`:27`）。
- **`web/js/audio/engine.js`**
  - 不再重建整条音频（替换 `buildEdited`，`:346`）。改为对原始音频的每个保留段各排一个 `AudioBufferSourceNode`，用增益做淡化。
  - 这样剪辑立刻生效，内存减半。
  - 计时器保持「剪后时间」，即这次修好的行为。
- **`web/js/ui/`**：`store`、`home`、`editor`、`transcript`、`waveform`、`transport`、`cleanup`、`exportDialog`、`settings`、`toast`、`shortcuts`、`i18n`（含 `locales/zh`、`locales/en`）、`icons`。
- **`web/css/`**：`tokens`、`base`、`layout`、`components`、`editor`。
  - 浅色和深色的颜色变量都定义在 `tokens` 里。
  - 用系统字体，保证离线可用。

### 剪辑数据：`edits.json`

```json
{ "version": 4, "cuts": [[a,b]], "pauses": [{"at":t,"duration":d}], "splits": [t],
  "fixes": {"<wordIndex>": "改后文字"}, "ignored": ["<suggestionKey>"], "settings": {"pauseThreshold": 0.8} }
```

v3 的 `hidden` 用数组下标记录被处理过的建议，建议列表一变就会对错号。v4 改用稳定的 key：类型加时间段。

## AI 部分（README 照实写）

- **Whisper**（faster-whisper，small 或 large-v3-turbo）：转录、词级时间戳、每个词的置信度。用提示词让它保留口误。
- **Silero VAD**：faster-whisper 自带，用 `vad_filter` 开启。
- **规则和信号处理**：重录、语气词、口吃、停顿的识别都是启发式规则，静音和杂音靠能量分析。README 会明确写这些不是 AI。

## 里程碑（MYT）

| 阶段 | 时间 | 内容 | 完成标准 |
| --- | --- | --- | --- |
| M0 基础 | 11/26 上午 | 开 `v4` 分支；把纯逻辑原样搬进 `core/`；`node --test` 锁住 v3 行为（含刚修的 3 个 bug）；搭好 Python `unittest`；写 `docs/api.md` 定 API | 测试全绿，界面行为和 v3 一致，commit |
| M1 后端 | 11/26 | `takecut/` 包、项目持久化、任务队列、转录升级、能量分析、导出渲染；中文示例用新流程重转；用 Windows 英文语音合成一个英文示例再转录 | Python 测试全绿；导出时长和剪后时长相差 ≤ 1 帧 |
| M2 前端骨架 | 11/26–27 | 首页和编辑器、主题、双语、播放引擎、逐字稿、波形、播放控制、提示、快捷键 | v3 的功能全部能用 |
| M3 功能 | 11/27 | 一键清理四类、改字、重做、导出对话框、智能剪点；有时间再做 P1 | 走查通过 |
| M4 冻结合并 | 11/27 20:00 | 全量回归；README 中英版更新；合并进 main，你用 GitHub Desktop 推送 | main 上是 v4 |

- 冻结后到 11/28 06:00 留给截图、Devpost 文字和演示视频（视频由你录），不算在这个计划里。
- M0 完成后，M1（`takecut/`、`tests/py`）和 M2（`web/`、`tests/js`）改的是不同文件，可以并行。如果你想更快，也愿意多花 token，可以让我另开一个 session 跑后端。默认我在这里按顺序做。
- 落后预案：11/27 中午还没赶上，就先砍 P0 第 8 项（智能剪点），再砍降噪和 VTT。v3 始终是保底。

## 验证

- **`node --test tests/js`**：时间轴换算和气口锚点（含 3 个旧 bug 的回归）、四类建议（用示例词表加人造用例）、字幕时间。
- **`py -3 -m unittest discover tests/py`**：
  - 项目存储；
  - 用人造的「音调 + 静音」WAV 测能量分析；
  - 检查 filtergraph 生成，并用 ffprobe 核对导出时长；
  - 起一个测试服务器跑一遍 API。
- **浏览器走查**（内置浏览器）：
  - 中文和英文示例各走一遍：导入、转录（CPU small 和 GPU turbo 各一次）、一键清理四类、改字、撤销和重做、导出 WAV、MP3 和 SRT；
  - 重启服务后项目还在；
  - 深色主题和英文界面都检查一遍。
- **你**：合并前用一段自己的真实录音试一次。

## 风险

- **时间**：P0 分量很大。按上面的落后预案砍功能，保住 v3 作为退路。
- **GPU**：Windows 上可能缺 cuDNN 或 cuBLAS 的 DLL。会自动退回 CPU，GPU 只是加速选项。
- **语气词识别**：提示词不一定能让 Whisper 保留所有语气词，没转出来的靠「有声音没文字」检测补上。
- **试听和导出不一致**：浏览器播放和 FFmpeg 渲染可能差几个采样。用测试锁定时长误差。
