# WrenchIT - Claude Code 指南

WrenchIT 是一个 VS Code 扩展，提供 Base64 编码/解码和 JSON 清理格式化功能，特别针对 Grafana JSON 格式。

## 项目概述

- **功能**: 
  - Base64 编码/解码
  - JSON 清理和格式化 (针对 Grafana)
- **技术栈**: TypeScript, VS Code Extension API
- **版本**: 0.1.0

## 开发环境

```bash
# 安装依赖
npm install

# 编译 TypeScript
npm run compile

# 监听模式 (开发时)
npm run watch

# 打包发布
npm run package
```

## 项目结构

```
WrenchIT/
├── src/
│   └── extension.ts    # 主扩展代码
├── package.json        # 扩展配置
├── tsconfig.json       # TypeScript 配置
└── .vscodeignore       # VS Code 忽略配置
```

## 架构: src/extension.ts

### 激活流程

扩展通过 `activationEvents` (目前为空数组，使用手动触发方式) 激活：

1. **激活**: `activate(context)` 注册三个命令
2. **命令注册**:
   - `wrenchit.encodeBase64` - Base64 编码
   - `wrenchit.decodeBase64` - Base64 解码
   - `wrenchit.fixJson` - JSON 清理和格式化

### 核心函数

#### 编辑器上下文获取

```typescript
function getEditorAndSelection(): {
  editor: vscode.TextEditor;
  selection: vscode.Selection;
  text: string;
} | undefined
```

#### Base64 编码/解码

使用 Node.js `Buffer` 进行编解码:
- `encodeBase64()`: 将选中文本编码为 Base64
- `decodeBase64()`: 将 Base64 文本解码为原始内容

#### JSON 清理 (Grafana JSON Cleaner)

`fixJson()` 函数使用 8 种策略的管道来处理各种损坏的 JSON:

1. 原始 JSON (已是有效 JSON)
2. 仅去除空白
3. 尝试解包外层引号
4. 包装并转义
5. 斜杠模式 + 反斜杠移除
6. 对称斜杠包装
7. Grafana 深度清理 (多通道)
8. 深度清理 + 解包

#### 清理策略详情

- **BOM 和行尾处理**: 移除 UTF-8 BOM，统一换行符
- **外层引号解包**: 处理 `"{...}"` 或 `"[...]"` 格式
- **斜杠包装移除**: 处理 `/"key/"` → `"key"` 格式
- **反斜杠转义**: `\"` → `"`, `\\"` → `\"`
- **尾部逗号移除**: `{...},` → `{...}`
- **字符串值中的 JSON 取消引用**: `"Content":"{...}"` → `"Content":{...}`

#### JSON 格式化器

`formatJsonText()` 在文本级别格式化 JSON，保留原始数字表示:
- `150.0` 保持为 `150.0` (不会变成 `150`)
- `3.14` 保持为 `3.14`
- 使用 2 空格缩进

## 发布流程

1. 确保代码已编译: `npm run compile`
2. 打包: `npm run package`
3. 这会生成 `.vsix` 文件
4. 在 VS Code 中通过 "Install from VSIX" 手动安装

或者使用 `vsce publish` 发布到 VS Code Marketplace (需要发布者账号)。

## 配置

扩展配置在 `package.json` 的 `contributes` 部分:

- **命令**: 3 个命令 (编码、解码、修复 JSON)
- **上下文菜单**: 编辑器右键菜单项

## 注意事项

- 所有函数使用同步操作，不需要异步处理
- 错误处理通过 `vscode.window.showErrorMessage` 和 `showWarningMessage`
- 选择文本时处理选中文本，未选中文本时处理整个文档
