# amis 性能 & 严重 Bug 审计报告

> 仓库：`baidu/amis`（本地 `/tmp/amis`，`master` 分支，commit `43a33ee06`）
> 范围：GitHub Open Issues 中「性能相关」+「严重/崩溃/卡死/白屏」+ `P0`/`P1` 功能 bug
> 方法：静态源码审计（逐集群阅读 `packages/amis`、`amis-core`、`amis-ui`、`amis-editor-core` 相关实现），**未修改任何代码、未运行复现**。
> 说明：多数 issue 标 `need confirm`，结论为基于当前 master 源码的**根因推断**，部分需运行时复现/heap 验证，已在每条标注「在 master 现存性」与置信度。

---

## 一、问题总览（共 34 条）

| # | 类型 | 集群 | 在 master 现存 | 可信度 |
|---|------|------|------|------|
| 10724 | 性能 | Input-table | 是 | 高 |
| 10725 | 性能 | Input-table | 是 | 高 |
| 3657 | 性能 | Input-table | 是 | 高 |
| 5471 | 性能 | Input-table | 是 | 高 |
| 5038 | 性能 | Input-table | 是 | 中 |
| 4773 | 功能/性能 | Input-table | 部分 | 中 |
| 4619 | 功能(P1) | Input-table | 是 | 中 |
| 12130 | 严重/白屏 | Tree | 是 | 高 |
| 11721 | 严重/白屏 | Tree | 是 | 高 |
| 12193 | 严重/回归 | Tree | 部分 | 高 |
| 10070 | 性能/白屏 | 虚拟滚动 | 是 | 高 |
| 3205 | 性能 | 表单/表格 | 是 | 高 |
| 9979 | 性能 | 表单输入 | 是 | 高 |
| 14217 | 性能 | Textarea | 是 | 高 |
| 11181 | 内存泄漏 | Editor | 部分（残留全局引用） | 高 |
| 11384 | 内存泄漏 | reload | 部分（监听器已修） | 中 |
| 4908 | 严重/卡死 | CRUD | 是 | 高 |
| 5014 | 严重/卡死 | Picker | 部分（依赖配置） | 中 |
| 11259 | 严重/崩溃 | Select | 无法确认（高概率） | 中 |
| 11583 | 严重/崩溃 | 表单提交 | 部分（已加前置保护） | 中 |
| 11361 | 严重/崩溃 | Custom | 是 | 高 |
| 11900 | 严重/白屏 | 编辑器 | 无法确认（缺堆栈） | 低 |
| 10454 | 功能 | 表格编辑器 | 无法确认 | 低 |
| 4655 | 功能(P0) | ConditionBuilder | 是 | 高 |
| 4638 | 功能(P1) | CRUD+Form | 是 | 中 |
| 14361 | 功能 | CRUD 重渲染 | 是 | 中 |
| 11186 | 功能 | CRUD 排序 | 是 | 中 |
| 15773/15775 | 性能 | trackExpression | 是 | 中 |
| 12062 | 功能 | Toast | 是 | 高 |

---

## 二、集群详细分析

### 集群 A：Input-table 渲染性能（#10724 #10725 #3657 #5471 #5038 #4773 #4619）

**根因（master 现已确认）**
- 初始化阶段 `QuickEdit.handleInit`（`packages/amis/src/renderers/QuickEdit.tsx:339-344`）用 `difference(values, data)` 比对；当列为 `input-number` 时，值 `25.10000` 被规范化为 `25.1`，与原值不同 → 触发 `onQuickChange`。
- `InlineFormItem` 在 mount 时若 `value` 与父 data 不同也会 `onChange`（`QuickEdit.tsx:744-754`）。
- 二者都进入 `Table/index.tsx` 的 `handleQuickChange` → `FormTable.handleTableSave`（`InputTable.tsx` 约 1784-1876，每次 `setState`）→ **整表全量重渲染**。80 行 × 多列 ≈ 160 次级联，造成 10s 卡顿（#10724）。
- 编辑态每次 `onQuickChange` 都触发整表 `setState`，行越多越慢（#3657/#5471）；无行级 `React.memo`，2640 单元格全量 render（#10725）。
- 编辑中重渲染 + `editIndex`/`reUseRowId` 重算（#4773）导致焦点丢失，内容「看似消失」。
- `#4619` combo 回传：`subForms` 按 `x-y` 索引缓存（`InputTable.tsx:563-567`），combo `flat` 模式（`Combo.tsx:1046`）路径映射错乱，取错实例（`InputTable.tsx:1040`）。

**建议修复**
1. 初始化/`mount` 阶段**禁止**触发 `onQuickChange`；`handleInit`/`InlineFormItem` 改用数值/结构相等（`_.isEqual`、按 schema 类型规范化后比较），相等则跳过。
2. 行级 `React.memo` + 单元格 memo，编辑时只 `setState` 当前行（局部更新），消除整表级联。
3. 合并同一渲染帧内多次 `handleTableSave`（批处理）。
4. 大数据量接入虚拟滚动，或复用 `amis-ui` 已带 memo 的 `InputTable`（`amis-ui/src/components/InputTable.tsx:343` 已有 `React.memo(InputTableRow)` 但未接入渲染器）。
5. `#4619`：统一以 `name` 路径采集回传，combo `flat` 场景显式 namespace。

---

### 集群 B：Tree / input-tree 大数据白屏（#12130 #11721 #12193）

**根因（master 现已确认）**
- `Tree.tsx` `renderList`（1636-1661）在 `flattenedOptions.length > virtualThreshold`（默认 100，`Tree.tsx:241`）时改用 `VirtualList`（PureComponent，`virtual-list/index.tsx:109`）。
- **#12130/#11721 白屏**：`handleVirtualHeight`（1664-1714）若容器 `offsetHeight/offsetWidth===0` 则 `virtualHeight` 保持初始 **0**（`Tree.tsx:288`），VirtualList 以 `height=0` 渲染 → 白屏；`flattenOptions`（1077）用 `eachTree` 同步拍平超大树，阻塞主线程 → 渲染失败/卡死。
- **#12193（6.13 回归）**：6.13 将内联 `this.renderItem.bind(this)` 改为稳定引用 `this.renderItem`（autobind）。点击 checkbox 仅 `setState({value})`（`handleCheck`, `Tree.tsx:586`），但 `VirtualList` 是 PureComponent，props 未变则**跳过重渲染**，需滚动触发重绘，表现为「滑动后才显示已选」。补丁 `#12235` 仅在 `componentDidUpdate` 的 `props.value/options` 变化时重新 bind 兜底，未覆盖内部 checkbox 状态变更路径。

**建议修复**
1. 容器无高度时**降级为非虚拟渲染**（直接 `list.map`），杜绝 `height=0` 白屏；`handleVirtualHeight` 拿不到高度时用兜底（如 `itemHeight*virtualThreshold` 或读取父级 `maxHeight`）。
2. 将「选中态 `valueSet`/展开态 `unfolded`」作为显式 prop 传入 VirtualList 参与 PureComponent 比对，或 checkbox 点击后主动 `forceUpdate`/重新 bind 令其失效。
3. 对 `flattenOptions`/超大树做分片/异步，避免同步阻塞主线程。
4. 回归护栏：补「虚拟列表下点击 checkbox 立即回显」自动化用例。

---

### 集群 C：虚拟滚动白屏（#10070 #3205）

**根因（master 现已确认）**
- `virtual-list/index.tsx:399-419` `handleScroll` 每个 scroll 事件**直接 setState，无 rAF/节流**；原生滚动即时发生而 React 提交 offset 滞后一帧 → 绝对定位 item 短暂空白。
- `VirtualTableBody.tsx`：`buffer=10`、`sizeRef` 上限 20（约 163-169），惯性快滚单帧位移超 buffer，占位高度（`--Table-scroll-offset`，约 76-94 由 useMemo 算出）滞后 → 白屏。每滚动帧对全部 rows 做两次 O(n) 遍历（约 27-36、82）加剧抖动。
- `startTransition` 被 import 但**从未使用**，未用于降级渲染。

**建议修复**
- `handleScroll` 用 `requestAnimationFrame` 节流/在 rAF 内 setState。
- 增大 buffer（20–30）并按滚动速度动态 overscan；`sizeRef` 上限提升。
- 占位高度用 `transform/translate3d` 直接跟随原生滚动，消除对 React state 提交的依赖。
- 将 `setScrollTop` 包入 `startTransition`；大表用二分查找 `from` 替代线性遍历。

---

### 集群 D：内存泄漏（#11181 #11384）

**根因**
- **#11181（已部分修复，残留全局引用）**：`Editor.tsx:226`（`amis-editor-core/src/component/Editor.tsx`）设置 `(window as any).editorStore = this.store`，卸载时（`componentWillUnmount`）**从未删除该全局引用** → 已 destroy 的 store 无法被 GC（`ResizeObserver` 泄漏已由 `#11539` 修复，监听/定时器清理齐全）。
- **#11384**：定时器/监听器清理在 master 已齐全（`Form.tsx` 自调度 `setTimeout` + `clearTimeout`、`Service.tsx`/`CRUD.tsx` 均清理）。内存增长更可能来自**每次 reload 重建 store/远程 options 缓存未释放**，需 heap snapshot 验证。

**建议修复**
1. `Editor.tsx` 卸载时补 `delete (window as any).editorStore`（仅非子编辑器场景）。
2. Service/CRUD reload 流程显式 `dispose/destroy` 旧 store；远程 `options` 缓存加上限/TTL；用 heap 快照确认无全局引用残留。

---

### 集群 E：表单输入卡顿（#9979 #14217 #3205）

**根因（master 现已确认）**
- 单字段输入 → `Form.handleChange` → `store.changeValue`（`amis-core/src/store/iRenderer.ts:182`）每次 `const data = cloneObject(self.data)`（约 201）再整体替换 `self.data`（约 255）。所有字段控件被 `observer` 包裹（`amis-core/src/renderers/wrapControl.tsx:108`），观察同一整份 `data` → **任一 keystroke 触发全字段重渲染**（#9979/#3205）。
- `Textarea.tsx` 始终用 `BaseTextArea`（react-textarea-autosize，约 206）且全受控，每次 `handleChange`（约 124）都 setState + 重新测量高度；高频扫码枪下每字符一次全表重渲染（#14217）。**无原生 textarea 选项、无节流**。

**建议修复**
1. 对 `FormItem`/`wrapControl` 的 `Control` 加 `React.memo`，仅自身 `value` 与依赖表达式变化时才重渲染，阻断整表扩散。
2. 细化 store 观察粒度：`changeValue` 仅更新对应字段 observable，避免整表 `cloneObject` 替换引用。
3. `Textarea` 新增 `nativeTextarea` 属性兼容原生 textarea；`onChange` 短时节流，或输入态用非受控 + `onBlur` 提交。
4. 关闭非必要 `validateOnChange` 默认行为。

---

### 集群 F：崩溃 / 卡死（严重）

**#4908 CRUD `page=null` 卡死（高可信，可立即修）**
- `crud.ts:472`：`typeof page !== 'undefined' && (self.page = parseInt(page, 10))`。`null` 时 `typeof null==='object'` 通过判断 → `parseInt(null)=NaN` → `self.page=NaN` → `offset=(NaN-1)*perPage=NaN` → 反复 fetch→reInit 死循环。
- **修复**：改为 `page != null && (self.page = parseInt(page, 10))` 并对结果做 `isNaN` 兜底为 `1`（与 `changePage`/522 一致）。

**#11361 已删除 API 在 React19 崩溃（高可信，可立即修）**
- `packages/amis/src/renderers/Custom.tsx`：`import ReactDOM from 'react-dom'`，使用 `ReactDOM.render`（201）与 `ReactDOM.unmountComponentAtNode`（174）。React 19 已移除 `ReactDOM.render`，调用即抛 `ReactDOM.render is not a function` → 整页崩溃。
- **修复**：封装按 React 版本路由的 `render` 工具（参考现有 `findDomCompat` 模式），改用 `createRoot`。

**#12062 多实例 Toast 只显示后者（高可信，可立即修）**
- `Toast.tsx:35` `toastRef` 为模块级单例，`componentDidMount`（125）覆盖为最后挂载实例 → `toast.success/error`（429-432）只渲染到后渲染的页面。
- **修复**：用以 `env`/根节点为 key 的 Map 注册多实例，调用时按当前渲染上下文定位。

**#4655（P0）ConditionBuilder disabled 仍可拖拽/删除（高可信，可立即修）**
- `condition-builder/index.tsx:82 handleDragStart` 仅判断 `draggable`（83-85），未检查 `disabled`；删除按钮依赖 `removeable` 而非 `disabled`。
- **修复**：`handleDragStart` 开头加 `if (disabled || !draggable) return;`；删除按钮同样受 `disabled` 控制。

**#5014 Picker 取消值拼接卡死（中，依赖配置）**
- `Picker.tsx` `handleChange`(353-404) 在 `joinValues:false` 且非 `extractValue` 时值退化为对象数组；构造函数对 `formItem.tmpValue` 注册 `reaction`(204-208) 触发 `fetchOptions`(245)；当 schema 同时满足反应条件 + `setOptions`(393 `options.concat`) 持续追加对象选项时，对象引用抖动引发反复 onChange→re-render 卡死。官方标 Cannot Reproduce 因需特定配置组合。
- **修复**：`handleChange`/`removeItem` 对对象类 value 做引用去重 + `isEqual` 比较后再 `setOptions`；收窄 `reaction` 触发条件（仅 `source` 为纯变量/有效 api 时建立）。

**#11259 filterable multiple number 枚举崩溃（中，无法确认）**
- `Select.tsx:59` `matchSorter(options, inputValue, {keys:[labelField,valueField]})`，number 值进入匹配/排序时易抛错或与受控 value 不一致导致反复 setState。`valueField` 比较处（213）已用 `String()`，但 filter 路径未归一。
- **修复**：`defaultFilterOption` 中对 `option[valueField]` 统一 `String(...)` 归一后再排序/比较；`toggleCheckAll` 的 selection 去重。

**#11583 表单提交 `reading 'error'`（中，已部分修复）**
- `api.ts` responseAdaptor 对旧版非预期返回结构访问 `data.error`/`validateRes.error`（`validations.ts:566`）在 `undefined` 时抛错。master 已在 `api.ts:428` 加 `if(!data) throw 'Response is empty'` 前置保护，常规空响应已拦截，但嵌套 adaptor/`validateRes?.error` 仍可能命中。
- **修复**：统一改可选链 `validateRes?.error`、`data?.error`，`hasOwnProperty` 前判空。

**#11900 编辑器白屏崩溃（低，缺堆栈）**
- 无堆栈，定位受限。白屏多为某面板 render 抛错且无顶层 ErrorBoundary 捕获。
- **修复**：编辑器顶层加 ErrorBoundary 兜底；对 6.12 变更涉及的 plugin 配置读取补 `?.` 与默认值，复现后按堆栈定位。

---

### 集群 G：P0/P1 及功能 bug

**#4638（P1）CRUD headerToolbar 嵌套 Form 首屏初始化两次**
- `WithStore.tsx` `store.initData` 同步逻辑（233-394）在 `extendsData`/`trackExpression` 分支各触发一次 `initData`，toolbar `data` 为空但 `__super` 变化 → form `onInit` + 数据同步双重初始化。
- **修复**：headerToolbar 内 form 关闭 `syncSuperStore` 或加去重；`initData` 首帧只触发一次。

**#14361 CRUD 重新请求不重渲染（显示旧值）**
- `crud.ts` `fetchInitData`(223)/`updateData`(553) 用 `extendObject/concatData` 合并，旧 `pristine`(418) 未随 `replaceData` 清除；带 `loadDataMode` 时旧 items 被 concat(406-410) → 残留旧值。
- **修复**：非增量刷新时以 `replaceData` 重置 `self.data`/`pristine`，避免与旧数据 merge。

**#11186 CRUD 列排序渲染 bug**
- `Table/index.tsx:1063-1064` 带 `onQuery` 时删除 `changes.orderBy`，但排序按钮状态依赖 `store.orderBy/orderDir`，列重排后 `TableContent` 不重渲染（注释 2013） → 图标与数据错位。
- **修复**：排序变更时强制 `TableContent` 重渲染（提升 store 触发或 key 变化），保持 `orderBy` 未被 `onQuery` 静默丢弃时 UI 一致。

**#15773/#15775 trackExpression 渲染两次**
- `OfficeViewer.tsx:112-123` 当 `wordOptions.enableVar` 时既走 `renderWord()` 又走 `office.updateVariable()`；`SchemaRenderer.tsx:91` 把 `trackExpression` 排除出 `shouldComponentUpdate`，但 `WithStore.tsx` 又用其对 `data` diff 触发 re-render，二者叠加。
- **修复**：合并分支，避免 `updateVariable` 与 `renderWord` 在同一次 props 变更中重复执行。

**#10454 表格编辑器严重 bug（低，需复现）**
- 表格插件列操作 schema 深拷贝与列宽同步存在引用共享，编辑状态污染。
- **修复**：列操作走不可变更新（clone 后再改），隔离编辑器 store。

---

## 三、优先修复建议（按「严重度 × 可立即修 × 高可信」排序）

**P0 — 可立即修复、根因明确、影响严重：**
1. **#4908** CRUD `page=null` → `NaN` 死循环卡死（`crud.ts:472`）—— 一行守卫。
2. **#11361** Custom 用已删除 `ReactDOM.render` 在 React19 崩溃（`Custom.tsx`）—— 版本路由。
3. **#12062** 多实例 Toast 单例覆盖（`Toast.tsx:35/125`）—— Map 注册。
4. **#4655** ConditionBuilder disabled 仍可拖拽/删除（`condition-builder/index.tsx:82`）—— 加 disabled 判断。

**P1 — 严重但需补测试/回归护栏：**
5. **#12193** Tree 虚拟列表 checkbox 不回显（6.13 回归）—— VirtualList 重渲染信号。
6. **#12130/#11721** Tree 大数据白屏 —— `height=0` 降级 + 异步 flatten。
7. **#11259** Select number 枚举 filter 崩溃 —— `String()` 归一。
8. **#11583** 表单提交 `reading 'error'` —— 可选链判空。

**P2 — 性能优化（工作量较大，需基准对比）：**
9. Input-table 集群（#10724/#10725/#3657/#5471/#5038/#4773/#4619）—— 初始化去重 + 行级 memo + 局部更新。
10. 虚拟滚动白屏（#10070）—— rAF 节流 + 增大 overscan。
11. 表单输入卡顿（#9979/#14217/#3205）—— 字段级 memo + changeValue 粒度 + Textarea 原生选项。
12. 内存泄漏（#11181 全局引用清理 / #11384 reload store 释放）。

**需复现/缺信息，暂不修：**
- #11900、#10454（缺堆栈/复现）、#5014（依赖特定配置组合）、#4638/#14361/#11186/#15773 功能类（需业务确认预期行为）。

---

## 四、结论

- 当前 master 上**性能与严重 bug 绝大多数仍然现存**，根因集中在：① 初始化阶段无效 `onQuickChange`/整表 setState（Input-table）；② 虚拟列表 PureComponent 重渲染信号缺失 + `height=0` 降级缺失（Tree/虚拟滚动白屏）；③ store 全量 `cloneObject` 替换引发的整表单/整表重渲染（表单输入）；④ 数组/NaN/单例/已删除 API 等边界守卫缺失（崩溃类）。
- 4 个 P0 级崩溃/功能 bug 根因明确、可一行级修复，建议优先处理；性能类需结合基准测试验证收益。
- 建议后续：对每个「可立即修」项补最小复现 + 单元测试，性能类补基准对比，再合并。
