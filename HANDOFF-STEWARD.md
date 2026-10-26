# Codex Guardian 项目状态总结

> 更新：2026-10-23 · 版本 v2.0.0

## 1. 目录结构与模块职责

```text
codex-429-guardian/
├── guardian.js
│   面板 UI、计划板、429 恢复、CDP 页面桥、模型/交付状态展示
├── scripts/
│   ├── steward-daemon.mjs
│   │   CDP 轮询、上下文采集、审核编排、交付请求处理
│   ├── policy-engine.mjs
│   │   任务分级、质量清单、计划校验、交付就绪判断
│   ├── llm-adapters.mjs
│   │   Provider 预设、主备回退、超时/限流/5xx 处理、冷却
│   ├── credential-store.mjs
│   │   macOS Keychain 适配层
│   ├── delivery-manager.mjs
│   │   交付预览、ZIP、MANIFEST、哈希校验、保守清理
│   ├── reliability-scorecard.mjs
│   │   两轮可靠性与安全评分
│   ├── e2e-self-test.mjs
│   │   CDP 闭环 E2E
│   └── llm-proxy.mjs
│       历史兼容代理，正常审核不走浏览器代理
├── test/
│   ├── guardian.test.cjs
│   ├── steward-plan-quality.test.cjs
│   ├── policy-engine.test.mjs
│   ├── credential-store.test.mjs
│   ├── llm-adapters.test.mjs
│   ├── delivery-manager.test.mjs
│   ├── daemon-integration.test.mjs
│   ├── delivery-ui.test.cjs
│   └── reliability-scorecard.test.mjs
├── docs/superpowers/specs/2026-10-23-guardian-complete-lifecycle-design.md
├── docs/superpowers/plans/2026-10-23-guardian-complete-lifecycle.md
├── resources/
├── README.md
└── install.sh / uninstall.sh
```

## 2. 当前已完成能力

| 能力 | 状态 |
|---|---|
| 429 自动恢复和后台会话守护 | 已完成 |
| 计划板按会话隔离、去重、倒计时、手动暂停 | 已完成 |
| 主任务完成且输出稳定后审核 | 已完成 |
| 项目目录、文档、SESSION/REA 证据读取 | 已完成 |
| 计划质量闸门：锚点、行为验收、接地、防依赖准备 | 已完成 |
| 任务分级和交付质量门禁 | 已完成 |
| OpenAI/Anthropic/DashScope/DeepSeek/OpenRouter/Ollama/Custom 适配 | 已完成 |
| 主模型失败后备用模型回退 | 已完成 |
| Provider 冷却和错误分类 | 已完成 |
| Keychain 凭据存储和旧 key 迁移 | 已完成 |
| 人工确认交付、二次确认 | 已完成 |
| ZIP + MANIFEST + SHA256SUMS | 已完成 |
| 项目指纹变化时中止备份 | 已完成 |
| 仅运行缓存的保守清理 | 已完成 |
| 两轮可靠性评分脚本 | 已完成 |

## 3. 已知短板与风险

| 短板 | 影响 | 优先级 |
|---|---|---|
| DOM/CDP 仍依赖 Codex 页面结构 | Codex 大改版可能破坏状态读取或确认按钮 | 高 |
| Keychain 首次访问可能触发系统授权 | 无交互 launchd 环境下需要用户预先允许 | 高 |
| 交付质量判断仍依赖有限的本地启发式规则 | 非代码类交付可能需要后续扩展任务模板 | 中 |
| 备份采用 ZIP 单包 | 超大仓库耗时和体积较高 | 中 |
| Fake provider 测试覆盖协议核心，但不替代真实多供应商长期压测 | 需继续积累真实兼容性矩阵 | 中 |
| 清理仅覆盖 Guardian 运行缓存 | 用户若要清构建产物，需要后续加入可配置标准清理 | 低 |

## 4. 关键入口

| 用途 | 文件 |
|---|---|
| 页面 UI/计划/交付状态 | `guardian.js` |
| 守护进程编排 | `scripts/steward-daemon.mjs` |
| 质量与交付策略 | `scripts/policy-engine.mjs` |
| 模型预设与回退 | `scripts/llm-adapters.mjs` |
| Keychain | `scripts/credential-store.mjs` |
| 备份与清理 | `scripts/delivery-manager.mjs` |
| 两轮评分 | `scripts/reliability-scorecard.mjs` |

## 5. 验证命令

```bash
NODE=/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node
$NODE --test test/*.test.cjs test/*.test.mjs
$NODE --check guardian.js
$NODE --check scripts/steward-daemon.mjs
$NODE scripts/e2e-self-test.mjs
$NODE scripts/reliability-scorecard.mjs --round both
```

安装：

```bash
bash install.sh
launchctl kickstart -k gui/$(id -u)/codex.guardian.steward
```

## 6. 后续候选任务

1. 增加更多非代码任务模板（文档、运营、数据报告）。
2. 增加可配置的标准清理模式，但仍保留人工预览。
3. 增加真实 Provider 兼容性 matrix 和定时健康检查。
4. 对超大仓库采用增量或分层交付包。

## 7. v2.1.1 修订（2026-10-25）
- 会话绑定声明：所有 LLM prompt（审核 + 对话）开头写明「当前会话名 + 编号 + 本会话记忆目录」，并显式禁止引用其他会话目录或别项目的 md（修复 onfuzz vs Infuse 会话串读 codex-429-guardian 的指令串项事故）。
- 会话记忆目录缺状态文件时，prompt 引导 LLM 走「## 需要会话总结」让主会话按五节写 SESSION-STATE.md，而非拿别项目文档充当依据。
- computeSessionKey() 与 currentThreadId() 同源：优先复用完整链（显式 id / annotation / 内容指纹），计划桶与会话记忆目录不再分叉。
- 新增 3 个回归测试（buildPrompt 会话绑定 × 2 + computeSessionKey 对齐 × 1），全量 148/148 绿。

## 8. v2.1.2 修订（2026-10-26）
- 指令口语化：审核 prompt 明确要求「像跟同事交代任务」，每条写清要做什么、改哪个文件/模块、做完怎么算成，并给出可模仿示例；格式重试、依据重试、质量重试三条兜底路径同步改为口语化要求。管家对话链路同样要求口语化。
- 管家窗口可读化：新增 readableStewardReply()，窗口只显示「我的判断 / 要注意的问题 / 下一步建议」，去掉【依据】标记与箭头链；完整依据仍写在管家日志，计划板仍是干净指令。
- 会话锁定加固：绑定声明升级为三条硬规矩（只用本会话材料、缺状态文件走「需要会话总结」、计划必须能对回本会话），审核、对话、三条重试路径全部注入。
- 测试 151/151 绿；node --check 两文件通过。

## 9. v2.1.3 修订（2026-10-26）
- 项目目录按会话绑定：settings.projectRootBySession[会话编号]，切换会话时面板只显示该会话自己的目录；没绑定就显示「本会话未绑定」，不再沿用上一个项目。
- 守护进程只采用本会话绑定的目录；旧版全局目录仅当该目录下已存在本会话自己的记忆文件夹时才兼容采用，否则留空并记录日志，杜绝跨项目读目录树/HANDOFF。
- 聊天、审核、记忆落盘统一使用同一个会话目录；新增 3 个单测覆盖「不回落别的会话目录」。
- 测试 154/154 绿。
