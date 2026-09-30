/**
 * 后台样式。与内容页同源（同一套 CSS 变量与暗色模式策略），
 * 但版式不同：左侧固定导航 + 右侧内容区。
 */

import { THEME_SWITCH_CSS } from './styles.ts';
import { baseCss } from './baseCss.ts';

export type AdminStyleOptions = {
  accentColor: string;
};

export function adminCss(options: AdminStyleOptions): string {
  // 变量、重置、面包屑、表格、图标、空状态、通知条都和内容页共用同一份
  // （见 views/baseCss.ts）。这里只写后台专有的版式。
  //
  // ★ 共用的那部分在**前面**，所以后台想改哪一条都得在后文覆盖它 ——
  //   而覆盖的权重必须够：`tbody td`（0,0,2）不是随便一条 `td` 能盖掉的。
  const base = baseCss({
    accentColor: options.accentColor,
    folderColor: '#f59e0b', // 后台不发布文件夹图标给访客看，取默认值即可
    cellPadY: '10px',
    rowLine: '1.6',
  });

  return `${base}
body {
  background: var(--bg); color: var(--fg); min-height: 100vh;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei",
    "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", sans-serif;
  font-size: 14px; line-height: 1.6; -webkit-font-smoothing: antialiased;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }

.layout { display: flex; min-height: 100vh; }

/* ---------- 侧边栏 ---------- */
.side {
  width: 210px; flex: 0 0 210px; background: var(--card);
  border-right: 1px solid var(--line); padding: 18px 0;
  position: sticky; top: 0; height: 100vh; overflow-y: auto;
}
.brand { padding: 0 18px 16px; font-weight: 600; font-size: 15px; }
.brand small { display: block; font-weight: 400; color: var(--muted); font-size: 12px; margin-top: 2px; }
.side nav a {
  display: block; padding: 9px 18px; color: var(--fg); font-size: 14px;
  border-left: 3px solid transparent;
}
.side nav a:hover { background: var(--hover); text-decoration: none; }
.side nav a.active { border-left-color: var(--accent); color: var(--accent); background: var(--hover); font-weight: 500; }

/* 汉堡按钮与遮罩在宽屏下不存在，由断点里的规则放出来 */
.burger, .nav-scrim { display: none; }

/* ---------- 顶栏 ---------- */
.main { flex: 1; min-width: 0; }
.top {
  display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
  padding: 12px 24px; background: var(--card); border-bottom: 1px solid var(--line);
}
.top .spacer { flex: 1; }
/* 主题切换的显隐规则与内容页共用同一份（见 views/styles.ts），这里只补版式 */
${THEME_SWITCH_CSS}
.theme-switch { align-items: center; gap: 6px; }
.theme-switch svg { display: block; }
/* 顶栏那对「明亮 / 黑暗」要和旁边的 .btn 长得一模一样。
   内容页那边靠 styles.ts 里的一条 .lang-switch, .theme-switch 规则给了边框内边距，
   而后台不加载那份样式表 —— 于是它一直是裸链接，跟旁边的按钮不是一路。
   ★ 只抄盒子属性，**不要碰 display**：显隐由上面 THEME_SWITCH_CSS 里
   :root .theme-switch（权重 0,2,0）和按主题放行的那几条控制，
   这里要是也写 display，权重相同、位置更靠后，就会把「藏起来」那条盖掉，
   结果是两个按钮同时显示。 */
.top .theme-switch {
  padding: 8px 16px; font-size: 14px; font-family: inherit;
  border: 1px solid var(--line); border-radius: 7px;
  background: var(--card); color: var(--fg);
}
.top .theme-switch:hover { background: var(--hover); }
.top .who { color: var(--muted); font-size: 12px; }
.content { padding: 24px; max-width: 1080px; }

h1 { font-size: 20px; font-weight: 600; margin-bottom: 6px; }
h2 { font-size: 15px; font-weight: 600; margin: 0 0 4px; }
.lead { color: var(--muted); font-size: 13px; margin-bottom: 18px; }

/* ---------- 只读表单的容器 ----------
   整页只读时用一个 fieldset[disabled] 罩住所有控件（见 adminAppearance.ts）。
   浏览器给 fieldset 的默认样式是 2px 凹槽边框，必须靠类名清掉，不能写内联
   style：本站的 CSP 是 style-src 'nonce-...'，内联 style 属性会被直接拒绝，
   于是那条 border:none 永远不会生效，页面上凭空多出一圈框。
   min-inline-size 也要归零：UA 样式表给的是 min-content，会让里面的卡片
   在窄屏上撑出去、不肯收缩。 */
.fieldset-bare {
  border: none; padding: 0; margin: 0; min-inline-size: 0;
}

/* ---------- 卡片 ---------- */
.card {
  background: var(--card); border: 1px solid var(--line);
  border-radius: var(--radius); padding: 18px; margin-bottom: 16px;
}
.card > h2 { margin-bottom: 12px; }
.card > .hint { color: var(--muted); font-size: 12px; margin: 4px 0 0; }

/* ---------- 提示条 ---------- */
.banner {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 14px; border-radius: 8px; margin-bottom: 14px; font-size: 13px;
  border: 1px solid var(--line); background: var(--hover);
}
.banner.ok { border-color: var(--ok); color: var(--ok); }
.banner.err { border-color: var(--danger); color: var(--danger); }
.banner.warn { border-color: var(--warn); color: var(--warn); }

/* ---------- 表单 ---------- */
.field { margin-bottom: 14px; }
.field > label { display: block; font-size: 13px; font-weight: 500; margin-bottom: 4px; }
.field .hint { color: var(--muted); font-size: 12px; margin-top: 4px; }
input[type="text"], input[type="password"], input[type="number"], select, textarea {
  width: 100%; padding: 8px 11px; font-size: 14px; font-family: inherit;
  color: var(--fg); background: var(--bg);
  border: 1px solid var(--line); border-radius: 7px; outline: none;
}
input:focus, select:focus, textarea:focus { border-color: var(--accent); }
textarea { min-height: 90px; resize: vertical; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 13px; }
input[type="color"] { width: 48px; height: 34px; padding: 2px; border: 1px solid var(--line); border-radius: 7px; background: var(--bg); }
.row { display: flex; gap: 14px; flex-wrap: wrap; }
.row > .field { flex: 1 1 220px; margin-bottom: 14px; }
/* 一份文案的中英两栏：窄屏自动上下堆叠 */
.localized { display: flex; gap: 10px; flex-wrap: wrap; }
.localized-item { flex: 1 1 220px; min-width: 0; }
.lang-tag {
  display: block; font-size: 11px; color: var(--muted);
  margin-bottom: 3px; letter-spacing: .03em;
}
.check { display: flex; align-items: flex-start; gap: 9px; margin-bottom: 10px; }
.check input { margin-top: 3px; flex: 0 0 auto; }
.check label { font-size: 14px; }
.check .hint { color: var(--muted); font-size: 12px; }

/* ---------- 按钮 ---------- */
button, .btn {
  display: inline-block; padding: 8px 16px; font-size: 14px; font-family: inherit;
  border: 1px solid var(--line); border-radius: 7px; cursor: pointer;
  background: var(--card); color: var(--fg); text-decoration: none;
}
button:hover, .btn:hover { background: var(--hover); text-decoration: none; }
button.primary, .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button.primary:hover { filter: brightness(1.08); }
button.danger, .btn.danger { color: var(--danger); border-color: var(--danger); background: transparent; }
button.danger:hover { background: var(--danger); color: #fff; }
button:disabled { opacity: .55; cursor: not-allowed; }
.actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 6px; }

/* ---------- 表格 ----------
   结构（表头底色、行 hover、固定布局、手机端折叠）全部来自 baseCss，
   这里只补后台特有的两类单元格：等宽路径、右对齐数字。
   以前这里另写了一套 table/th/td —— 结果后台表格没有固定布局、没有行 hover、
   窄屏也没有列折叠，和内容页两张皮。 */
td.mono, .mono { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; word-break: break-all; }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
.tag {
  display: inline-block; padding: 1px 7px; border-radius: 20px;
  font-size: 11px; border: 1px solid var(--line); color: var(--muted);
}
.tag.ok { color: var(--ok); border-color: var(--ok); }
.tag.off { color: var(--muted); }
.tag.warn { color: var(--warn); border-color: var(--warn); }
.tag.err { color: var(--danger); border-color: var(--danger); }

/* ---------- 概览统计 ---------- */
.stats { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
.stat {
  flex: 1 1 150px; background: var(--card); border: 1px solid var(--line);
  border-radius: var(--radius); padding: 14px 16px;
}
.stat .k { color: var(--muted); font-size: 12px; }
.stat .v { font-size: 20px; font-weight: 600; margin-top: 3px; word-break: break-all; }
.stat .v.small { font-size: 13px; font-weight: 400; }

/* ---------- 登录页 ---------- */
.login-wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
.login-box {
  width: 100%; max-width: 380px; background: var(--card);
  border: 1px solid var(--line); border-radius: var(--radius); padding: 28px;
}
.login-box h1 { font-size: 18px; margin-bottom: 4px; }
.login-box .lead { margin-bottom: 18px; }

/* ---------- 版式小工具 ----------
   本站的 CSP 是 style-src 'nonce-...'，**内联 style 属性会被浏览器直接丢掉**
   （不报错、不警告，就是不生效）。仓库里散着三十来处 style="..."，它们
   目前全都没有起作用 —— 页面上看到的是「样式没写」的样子，不是作者设计的样子。
   下面这些类就是把它们接回来。

   刻意只留这么多：需要「一段间距」「让这行内联」时用它，
   不要再往里长业务样式（那种应该有自己的类名）。 */
.mt-12 { margin-top: 12px; }
.mt-14 { margin-top: 14px; }
.mt-16 { margin-top: 16px; }
.mb-12 { margin-bottom: 12px; }
.mb-16 { margin-bottom: 16px; }
.mb-20 { margin-bottom: 20px; }
.form-inline { display: inline; }
.full { width: 100%; }
.muted { color: var(--muted); }
.err-text { color: var(--danger); }
.hr { border: none; border-top: 1px solid var(--line); margin: 16px 0; }
.w-38 { width: 38%; }
.w-120 { width: 120px; }
/* 筛选行里的字段：并排一行，不要再各带一段下边距 */
.field-tight { flex: 0 0 auto; margin: 0; }
.field-narrow { flex: 0 0 140px; margin: 0; }
.field-wide { flex: 1 1 200px; margin: 0; }
.field-grow { flex: 1 1 auto; margin: 0; }
/* 复选框 + 文字的整行标签，也用在 .btn 上（日志页的自动刷新） */
.check-inline { display: flex; gap: 7px; align-items: center; font-weight: 400; margin: 0; }
.btn .check-inline, label.btn { cursor: pointer; }
.color-row { display: flex; gap: 10px; align-items: center; }
.color-hex { max-width: 140px; }

/* ---------- 表格行内操作 ----------
   ★ 必须允许换行。
   表格是 table-layout: fixed，每一列只拿到「表格宽度 ÷ 列数」——目录页 5 列，
   操作列在 1080px 的版心上是 206px，而五个按钮排一行要 338px。不给换行的话
   它们会横向溢出单元格，再被 .panel 的 overflow: hidden 裁掉 ——
   表现就是「最后那个删除按钮看不见了」，而且宽屏窄屏都会发生。
   允许换行之后，按钮自己排成两行（打开/二维码/编辑 一行，删除类一行），
   任何宽度下都在单元格里。 */
.row-actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; white-space: nowrap; }

/* 操作列现在只有三个按钮（打开 / 二维码 / 编辑），均分给的那点宽度就够了，
   两个删除类动作在编辑弹窗里（见 adminDirectories.ts 的 dangerZone）。 */

/* ---------- 编辑弹窗底部的「危险操作」 ----------
   和上面的保存按钮隔开、有自己的边框和标题 —— 这两个动作的后果
   和「保存」完全不是一个量级，长得像普通按钮会让人顺手点下去。 */
.danger-zone {
  margin-top: 22px; padding-top: 16px;
  border-top: 1px solid var(--line);
}
.danger-zone > h3.sub { margin-top: 0; }
.danger-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 8px; }
.danger-row > .hint { flex: 1 1 200px; margin: 0; }
.danger-zone .act {
  flex: 0 0 auto; padding: 8px 12px; font-size: 13px; line-height: 1.5;
  border: 1px solid var(--line); border-radius: 6px;
  background: transparent; color: var(--fg); cursor: pointer;
  font-family: inherit; text-decoration: none;
}
.danger-zone .act:hover { background: var(--hover); }
.danger-zone .act.danger { color: var(--danger); border-color: var(--danger); }
.danger-zone .act.danger:hover { background: var(--danger); color: #fff; }
/* 行内操作按钮：内边距按「手指点得中」给的，不是按桌面鼠标给的 ——
   一列四五个按钮挨在一起，24px 高在手机上几乎必然点错一个（而其中一个是删除）。 */
.row-actions .act {
  display: inline-block; padding: 8px 12px; font-size: 12px; line-height: 1.5;
  border: 1px solid var(--line); border-radius: 6px;
  background: transparent; color: var(--fg); cursor: pointer;
  font-family: inherit; text-decoration: none;
}
.row-actions .act:hover { background: var(--hover); text-decoration: none; }
.row-actions .act.open { color: var(--accent); border-color: var(--accent); }
.row-actions .act.danger { color: var(--muted); border-color: transparent; }
.row-actions .act.danger:hover { background: var(--danger); border-color: var(--danger); color: #fff; }
/* 表格里嵌了 form 时不要撑开行高 */
.row-actions form { margin: 0; }

/* ---------- 上传区 ---------- */
.drop-zone {
  border: 2px dashed var(--line); border-radius: var(--radius);
  padding: 26px 20px; text-align: center; background: var(--bg);
  transition: border-color .15s, background .15s;
}
.drop-zone.over { border-color: var(--accent); background: var(--hover); }
.drop-zone p { margin-bottom: 12px; color: var(--muted); font-size: 13px; }
.drop-zone button { margin-bottom: 8px; }
.upload-status { margin-top: 12px; }
.upload-row {
  padding: 6px 10px; border-radius: 6px; font-size: 12px;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  word-break: break-all;
}
.upload-row.ok { color: var(--ok); }
.upload-row.err { color: var(--danger); }

/* ---------- 弹窗 ---------- */
.dialog {
  /* ★ 必须显式写 position/inset/margin。
     原生 <dialog> 靠 UA 样式表里的 margin:auto 居中，而本文件顶部的
     通配符重置（margin 归零）会把它一起清掉，结果弹窗贴到视口左上角。
     这里用类选择器（优先级高于通配符）恢复。
     注意：本段是模板字符串的一部分，注释里不能出现反引号。 */
  position: fixed;
  inset: 0;
  margin: auto;
  border: 1px solid var(--line); border-radius: var(--radius);
  background: var(--card); color: var(--fg);
  padding: 0; width: calc(100% - 32px); max-width: 640px;
  height: fit-content; max-height: 86vh; overflow: auto;
}
.dialog::backdrop { background: rgba(0, 0, 0, .45); }
.dialog form { padding: 22px; }
.dialog h2 { margin-bottom: 16px; }
.dialog-actions {
  display: flex; gap: 10px; justify-content: flex-end; flex-wrap: wrap;
  margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--line);
}
/* 二维码预览：白底不能跟着深色主题走 —— 深色背景上的二维码扫不出来 */
.qr-frame {
  display: flex; justify-content: center; padding: 16px; margin: 4px 0 14px;
  background: #ffffff; border: 1px solid var(--line); border-radius: 10px;
}
.qr-frame img { display: block; width: 240px; height: 240px; image-rendering: pixelated; }
/* 域名与证书页：Caddyfile 预览 */
.code-block {
  margin-top: 12px; padding: 14px; overflow-x: auto;
  background: var(--bg); border: 1px solid var(--line); border-radius: 8px;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 12px; line-height: 1.55; white-space: pre; color: var(--fg);
}
.kv {
  display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap;
  padding: 6px 0; font-size: 13px;
}
.kv > span:first-child { color: var(--muted); min-width: 96px; }
.kv > span:last-child { word-break: break-all; }
h3.sub { margin: 18px 0 8px; font-size: 13px; color: var(--muted); font-weight: 600; }
details.advanced { margin: 6px 0 14px; }
details.advanced > summary {
  cursor: pointer; font-size: 13px; color: var(--muted); padding: 6px 0;
}
details.advanced > summary:hover { color: var(--accent); }

.qr-target {
  padding: 8px 10px; border-radius: 7px; background: var(--bg);
  border: 1px solid var(--line);
}

/* ---------- 目录名选择器 ---------- */
/* 不做自己的滚动条：嵌在对话框里再嵌一层滚动区，手机上很容易滚错层 */
.picker {
  border: 1px solid var(--line); border-radius: 8px; padding: 8px;
  background: var(--bg);
}
.picker .hint { color: var(--muted); font-size: 12px; margin: 2px 4px 8px; }
.picker-item {
  display: flex; align-items: center; gap: 8px;
  width: 100%; min-height: 40px; padding: 8px 10px;
  background: none; border: 0; border-radius: 6px;
  color: inherit; font: inherit; font-size: 14px; text-align: left; cursor: pointer;
}
.picker-item:hover { background: var(--hover); }

/* 图标（.ic / .ic.dir）与空状态（.empty）来自 baseCss，与内容页是同一份定义 */

/* 扫描导入的勾选行：整行可点，高度往 44px 那条触屏经验线靠 */
.scan-item {
  align-items: center; gap: 10px; margin-bottom: 2px;
  padding: 9px 10px; border-radius: 7px; cursor: pointer;
}
.scan-item:hover { background: var(--hover); }
.scan-item input { margin: 0; flex: 0 0 auto; }
.scan-item .scan-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.scan-item .ic { flex: 0 0 22px; }
.scan-item.done { cursor: default; color: var(--muted); }
.scan-item.done:hover { background: none; }
/* 输入框 + 紧跟其后的按钮。窄屏上按钮换到下一行，不要被压成一小条 */
.field-inline { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.field-inline input { flex: 1 1 200px; min-width: 0; }

/* 文件管理页顶部的「选目录 + 确定」 */
.pick-row { align-items: flex-end; }
.pick-dir { flex: 1 1 240px; margin-bottom: 0; }

/* 表格里的一整格错误提示（内容页那套 .notice 是块级的，塞不进 td） */
.cell-err { color: var(--danger); }
.cell-err, td.empty { text-align: center; }

/* ---------- 预览 iframe ---------- */
.preview-frame {
  width: 100%; height: 480px; border: 1px solid var(--line);
  border-radius: 8px; background: #fff;
}

/* ---------- 窄屏：无 JS 时的样子 ----------
   侧栏变成页首一条横向导航。朴素，但**能走**。

   ★ 这一层是「没有 JS」的兜底，不是过渡态。有 JS 时下面那段会把它整个盖掉，
     换成抽屉。两段都在同一个断点里，靠 html.js 前缀分胜负（权重 0,2,x > 0,1,x）。 */
@media (max-width: 780px) {
  .layout { flex-direction: column; }
  .side { width: auto; flex: none; height: auto; position: static; border-right: none; border-bottom: 1px solid var(--line); }
  .side nav { display: flex; flex-wrap: wrap; }
  .side nav a { border-left: none; border-bottom: 3px solid transparent; }
  .side nav a.active { border-left: none; border-bottom-color: var(--accent); }
  .content { padding: 16px; }
  .top { padding: 10px 16px; }
}

/* ---------- 窄屏：有 JS 时的抽屉 ----------
   全部规则带 html.js 前缀 —— 不是洁癖，是**必须**：
   上面那段同断点的规则权重是 0,1,x，这里不带前缀就压不住它，
   会得到「一半横条一半抽屉」的混合体。 */
@media (max-width: 780px) {
  html.js .layout { display: block; }
  html.js .side {
    position: fixed; top: 0; left: 0; bottom: 0; z-index: 30;
    width: 260px; max-width: 84vw; height: 100vh;
    border-right: 1px solid var(--line); border-bottom: none;
    padding: 18px 0; overflow-y: auto;
    transform: translateX(-100%);
    transition: transform .2s ease;
  }
  html.js .side.open { transform: none; }
  html.js .side nav { display: block; }
  html.js .side nav a {
    border-left: 3px solid transparent; border-bottom: none;
    /* 触屏上手指按得准的行高，抽屉里不必像桌面那样紧凑 */
    padding: 13px 18px;
  }
  html.js .side nav a.active { border-left-color: var(--accent); border-bottom-color: transparent; }

  /* 遮罩挂在 .side.open 的后面兄弟节点上，不需要脚本再管一个类 */
  html.js .nav-scrim {
    display: block; position: fixed; inset: 0; z-index: 20;
    background: rgba(0, 0, 0, .45); opacity: 0; pointer-events: none;
    transition: opacity .2s ease;
  }
  html.js .side.open + .nav-scrim { opacity: 1; pointer-events: auto; }

  html.js .burger {
    display: inline-flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 4px; width: 42px; height: 38px; padding: 0; flex: 0 0 auto;
  }
  html.js .burger span { display: block; width: 18px; height: 2px; border-radius: 2px; background: var(--fg); }
}

@media (max-width: 640px) {
  /* 手机上对话框铺满：留 32px 的白边只会让本来就不宽的表单更挤 */
  .dialog {
    width: 100%; max-width: none; height: 100vh; max-height: 100vh;
    border: none; border-radius: 0;
  }
  .dialog form { padding: 16px; }
  /* 二维码固定 240px，320px 的视口会横向溢出 */
  .qr-frame img { max-width: 100%; height: auto; }
  /* 顶栏挤不下时先把身份标签收起来 —— 它只是确认「我是谁」，不是操作 */
  .top .who { display: none; }
  .content { padding: 14px 12px; }
}
`.trim();
}
