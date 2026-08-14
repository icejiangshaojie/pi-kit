---
name: pre-push-checks
description: Use before pushing or opening a PR in ANY project to select the smallest set of checks (analyze/lint/test/build) that covers the outgoing diff, instead of reflexively running the full suite. Generic version — project-specific skills (e.g. limao-pre-push-checks) take precedence when present.
---

# Pre-Push Checks（全局：最小覆盖检查）

**优先级**：项目有专属 pre-push skill（如 `limao-pre-push-checks`）→ 用项目版；没有 → 按本流程。

## 第一步：确定 diff 范围

```sh
git diff --name-only @{u}...HEAD 2>/dev/null || git diff --name-only origin/main...HEAD 2>/dev/null || git diff --name-only HEAD~1
```

## 第二步：识别检查器（按项目类型映射）

| 项目特征 | 改动桶 → 检查 |
|----------|---------------|
| pnpm/yarn/npm workspaces | 只 analyze/test 改动的包 |
| Flutter/Dart monorepo | 改动包各自 `flutter analyze`；`lib/features/X` → 对应 `test/features/X` |
| 单包 ts/js | `npm run lint` + 相关测试文件 |
| Go | `go vet ./changed/...` + 对应 `_test.go` |
| Python | 改动模块对应的 pytest 文件 |

有 lint 配置（eslint/oxlint/clippy…）→ lint 必跑且只跑改动范围。

## 第三步：升级为全量的触发条件（任一命中）

- 触及路由/认证/支付/核心入口/依赖清单（pubspec/package.json/requirements）
- 触及构建配置、CI 配置、codegen
- 用户点名完整验证

## 第四步：构建冒烟（仅当平台层有改动）

ios/android/native/desktop 配置改动 → 最小编译验证（不强求完整构建）。

## 输出格式

按 桶 → 检查 → 结果 列出，**标注哪些升级条件被检查过（即使未触发）**，让用户能判断覆盖面。检查器输出若已被 rtk 等工具压缩，不要贴原始日志。
