import 'dart:convert';
import 'dart:math' as math;
import 'package:flutter/material.dart';
import '../models/protocol.dart';
import '../l10n/generated/app_localizations.dart';
import '../theme.dart';
import '../locale.dart';

/// 工具执行步骤渲染：紧凑单行摘要 + 折叠的类型化结果卡片（对齐桌面端 ToolStep.tsx）。
/// 桌面端核心特征：无边框无卡片、图标（状态色）+ 粗体标题 + 「·」+ 摘要 + 状态标签；
/// 展开后左侧竖线缩进，结果按工具类型渲染（终端/文件行号/git diff/树形/截图/纯文本）。
/// 颜色统一走 AppColors（亮/暗主题切换自动刷新）；终端/代码块保持深色终端样式（与桌面端一致）。

/// context-free 取词入口（为什么不用 of(context) 见 friendlyToolName 上方注释）。
/// 只读 LocaleController 的当前偏好，且与 MaterialApp 的 locale 共用同一个解析函数
/// resolvedLocale → 「界面语言」与「这些函数取到的词」不可能不一致。
AppLocalizations get _l => lookupAppLocalizations(resolvedLocale(LocaleController.instance.value));

// 终端深色块固定色（亮暗主题下终端都保持深色终端样式）
const Color _kTerminalOutText = Color(0xFFD4D4D4); // 终端输出正文
const Color _kTerminalErrText = Color(0xFFF48771); // 终端 stderr（红）

/// 工具名 → 「怎么取词」（i18n 期7B 整表搬进 ARB）。
/// 【为什么存闭包而不是中文】历轮已 10 次实证：模块级常量表里存中文，
/// 会在加载期就固化成中文、切语言不变（STATUS_LABEL / TOOL_META / SECTIONS /
/// ROLE_META / CATEGORIES / PROTOCOL_OPTIONS / UPDATE_FAILURE_COPY /
/// SUPERVISOR_ARG_LABELS / SCOPE_LABEL+PHASE_TITLE / AppManifest）。
/// 表本身仍是 final（只建一次），但存闭包 → 渲染期才求值。
/// 未登记工具名回退原始工具名（与桌面端期2 toolTitle 口径一致）。
final Map<String, L10nText> _toolNameMap = {
  'read_file': (l) => l.toolReadFile,
  'write_file': (l) => l.toolWriteFile,
  'edit_file': (l) => l.toolEditFile,
  'run_command': (l) => l.toolRunCommand,
  'list_dir': (l) => l.toolListDir,
  'image_analyze': (l) => l.toolImageAnalyze,
  'computer_screenshot': (l) => l.toolComputerScreenshot,
  'computer_ocr': (l) => l.toolComputerOcr,
  'computer_action': (l) => l.toolComputerAction,
  'browser_create': (l) => l.toolBrowserCreate,
  'browser_list': (l) => l.toolBrowserList,
  'browser_navigate': (l) => l.toolBrowserNavigate,
  'browser_close': (l) => l.toolBrowserClose,
  'browser_screenshot': (l) => l.toolBrowserScreenshot,
  'browser_get_info': (l) => l.toolBrowserGetInfo,
  'browser_get_content': (l) => l.toolBrowserGetContent,
  'browser_evaluate': (l) => l.toolBrowserEvaluate,
  'browser_click': (l) => l.toolBrowserClick,
  'browser_type': (l) => l.toolBrowserType,
  'browser_scroll': (l) => l.toolBrowserScroll,
  'browser_wait': (l) => l.toolBrowserWait,
  'browser_get_console_logs': (l) => l.toolBrowserGetConsoleLogs,
  'browser_get_network_requests': (l) => l.toolBrowserGetNetworkRequests,
  'browser_get_cookies': (l) => l.toolBrowserGetCookies,
  'browser_set_cookie': (l) => l.toolBrowserSetCookie,
  'browser_clear_cookies': (l) => l.toolBrowserClearCookies,
  'rollback_file': (l) => l.toolRollbackFile,
  'remember': (l) => l.toolRemember,
  'recall_memory': (l) => l.toolRecallMemory,
  'plugin': (l) => l.toolPlugin,
  'session': (l) => l.toolSession,
  'list_models': (l) => l.toolListModels,
  'send_message': (l) => l.toolSendMessage,
  'inject_message': (l) => l.toolInjectMessage,
  'choose_model': (l) => l.toolChooseModel,
  'ask_user': (l) => l.toolAskUser,
  'mcp_list_tools': (l) => l.toolMcpListTools,
  'mcp_call': (l) => l.toolMcpCall,
  'skill_list': (l) => l.toolSkillList,
  'skill_read': (l) => l.toolSkillRead,
  'terminal_create': (l) => l.toolTerminalCreate,
  'terminal_run': (l) => l.toolTerminalRun,
  'terminal_list': (l) => l.toolTerminalList,
  'terminal_close': (l) => l.toolTerminalClose,
  'ledger': (l) => l.toolLedger,
  'answer_ask': (l) => l.toolAnswerAsk,
  'resolve_approval': (l) => l.toolResolveApproval,
};

/// skill_run 的 skillId:action → 取词闭包。值与 _toolNameMap 完全同名 →
/// 复用同一批 ARB key（不重复登记 20 条，否则两处措辞必然漂）。
final Map<String, L10nText> _skillActionNameMap = {
  'computer-use:screenshot': (l) => l.toolComputerScreenshot,
  'computer-use:ocr': (l) => l.toolComputerOcr,
  'computer-use:action': (l) => l.toolComputerAction,
  'browser-use:create': (l) => l.toolBrowserCreate,
  'browser-use:list': (l) => l.toolBrowserList,
  'browser-use:navigate': (l) => l.toolBrowserNavigate,
  'browser-use:close': (l) => l.toolBrowserClose,
  'browser-use:screenshot': (l) => l.toolBrowserScreenshot,
  'browser-use:get_info': (l) => l.toolBrowserGetInfo,
  'browser-use:get_content': (l) => l.toolBrowserGetContent,
  'browser-use:evaluate': (l) => l.toolBrowserEvaluate,
  'browser-use:click': (l) => l.toolBrowserClick,
  'browser-use:type': (l) => l.toolBrowserType,
  'browser-use:scroll': (l) => l.toolBrowserScroll,
  'browser-use:wait': (l) => l.toolBrowserWait,
  'browser-use:get_console_logs': (l) => l.toolBrowserGetConsoleLogs,
  'browser-use:get_network_requests': (l) => l.toolBrowserGetNetworkRequests,
  'browser-use:get_cookies': (l) => l.toolBrowserGetCookies,
  'browser-use:set_cookie': (l) => l.toolBrowserSetCookie,
  'browser-use:clear_cookies': (l) => l.toolBrowserClearCookies,
};

/// plugin 顶层工具（插件统一入口）的 action → 取词闭包
final Map<String, L10nText> _pluginActionNameMap = {
  'list': (l) => l.toolPluginActionList,
  'inspect': (l) => l.toolPluginActionInspect,
  'scaffold': (l) => l.toolPluginActionScaffold,
  'build': (l) => l.toolPluginActionBuild,
  'test-load': (l) => l.toolPluginActionTestLoad,
  'verify': (l) => l.toolPluginActionVerify,
  'install': (l) => l.toolPluginActionInstall,
  'publish': (l) => l.toolPluginActionPublish,
  'uninstall': (l) => l.toolPluginActionUninstall,
  'tool': (l) => l.toolPluginActionTool,
};

/// ledger 顶层工具（管家台账统一入口）的 action → 取词闭包
final Map<String, L10nText> _ledgerActionNameMap = {
  'list': (l) => l.toolLedgerActionList,
  'read': (l) => l.toolLedgerActionRead,
  'write': (l) => l.toolLedgerActionWrite,
  'edit': (l) => l.toolLedgerActionEdit,
};

/// session 顶层工具（会话实体管理统一入口）的 action → 取词闭包
final Map<String, L10nText> _sessionActionNameMap = {
  'list': (l) => l.toolSessionActionList,
  'inspect': (l) => l.toolSessionActionInspect,
  'switch': (l) => l.toolSessionActionSwitch,
  'create': (l) => l.toolSessionActionCreate,
  'rename': (l) => l.toolSessionActionRename,
  'set_workdir': (l) => l.toolSessionActionSetWorkdir,
  'delete': (l) => l.toolSessionActionDelete,
  'set_model': (l) => l.toolSessionActionSetModel,
  'set_approval': (l) => l.toolSessionActionSetApproval,
  'choose': (l) => l.toolSessionActionChoose,
  'resume': (l) => l.toolSessionActionResume,
};

/// 工具名 → 中文显示名（skill_run / plugin / ledger / session 按 action 细分，未知名回退「工具操作」）
/// 工具名 → 当前语言的显示名。
///
/// 【取词入口为什么不走 AppLocalizations.of(context)】本函数与 toolSummary /
/// riskLevelLabel / approvalArgsWidget / formatDurationMs / truncateText 都是历轮遗留的
/// 顶层纯函数，调用方在 chat_view.dart / message_bubbles.dart（属 7C，本期禁止触碰）；
/// 加 BuildContext 参数会让它们编译不过。这里走 gen_l10n 自己生成的
/// lookupAppLocalizations —— 与 MaterialApp 内部加载词条同一条路径、同一份 ARB，
/// 不是第二套真相（7A 的 brandTitleFor 是同一做法）。
///
/// 【本期实测过会不会停在旧语言】不会。RC1 把 ToolStepWidget 里的 of(context)
/// 换成 _l（等于不登记任何语言依赖）后，切语言屏上文案照样变英文 ——
/// Flutter 的 locale 变化会重建整棵页面子树，与桌面端 React「漏订阅就停在旧语言」
/// 不同。所以 chat_view.dart / message_bubbles.dart 直接调这些函数不需要补订阅，
/// 7C 抽那两个文件时只翻文案即可（已按此更正，不留与实测相反的说明）。
String friendlyToolName(String name, Map<String, dynamic>? args) {
  final loc = _l;
  final action = args?['action']?.toString() ?? '';
  if (name == 'skill_run') {
    final skillId = args?['skillId']?.toString() ?? '';
    return (_skillActionNameMap['$skillId:$action'] ?? (l) => l.toolSkillFallback)(loc);
  }
  if (name == 'plugin') return (_pluginActionNameMap[action] ?? (l) => l.toolPlugin)(loc);
  if (name == 'ledger') return (_ledgerActionNameMap[action] ?? (l) => l.toolLedger)(loc);
  if (name == 'session') return (_sessionActionNameMap[action] ?? (l) => l.toolSession)(loc);
  return (_toolNameMap[name] ?? (l) => l.toolFallback)(loc);
}

/// 工具名 → 图标（Material Icons 映射桌面端语义图标）
IconData _toolIcon(String name) {
  switch (name) {
    case 'read_file':
      return Icons.description_outlined;
    case 'write_file':
    case 'edit_file':
    case 'rollback_file':
      return Icons.edit_outlined;
    case 'run_command':
      return Icons.terminal;
    case 'list_dir':
      return Icons.account_tree_outlined;
    case 'image_analyze':
      return Icons.image_outlined;
    case 'computer_screenshot':
    case 'computer_ocr':
    case 'computer_action':
      return Icons.monitor_outlined;
    case 'remember':
    case 'recall_memory':
      return Icons.schedule;
    case 'plugin':
      return Icons.code;
    case 'mcp_list_tools':
    case 'mcp_call':
      return Icons.hub_outlined;
    case 'skill_list':
    case 'skill_read':
      return Icons.auto_awesome_outlined;
    case 'terminal_create':
    case 'terminal_run':
    case 'terminal_list':
    case 'terminal_close':
      return Icons.terminal;
    case 'ledger':
      return Icons.book_outlined;
    case 'answer_ask':
      return Icons.question_answer_outlined;
    case 'resolve_approval':
      return Icons.fact_check_outlined;
    case 'session':
      return Icons.people_outline;
    case 'list_models':
      return Icons.memory;
    case 'send_message':
    case 'inject_message':
      return Icons.send;
    default:
      if (name.startsWith('browser')) return Icons.public;
      return Icons.build_outlined;
  }
}

/// skill_run 的 params 提取一行摘要（browser-use → url/selector，computer-use → 动作）
String _skillRunSummary(Map<String, dynamic> args) {
  final skillId = args['skillId']?.toString() ?? '';
  final action = args['action']?.toString() ?? '';
  final params = args['params'] is Map ? (args['params'] as Map).cast<String, dynamic>() : <String, dynamic>{};
  if (skillId == 'browser-use') {
    if (action == 'navigate') return params['url']?.toString() ?? '';
    if (action == 'create') return params['url']?.toString() ?? params['appId']?.toString() ?? '';
    if (action == 'click' || action == 'type' || action == 'wait') return params['selector']?.toString() ?? '';
    if (action == 'get_content') return params['selector']?.toString() ?? '';
    if (action == 'scroll') return params['direction']?.toString() ?? '';
    if (action == 'close' || action == 'list') return params['appId']?.toString() ?? '';
  }
  if (skillId == 'computer-use' && action == 'action') return params['action']?.toString() ?? '';
  return '';
}

/// 从工具参数提取一行摘要（对齐桌面端 toolSummary）
String toolSummary(String name, Map<String, dynamic>? args) {
  if (args == null) return '';
  if (name == 'skill_run') return _skillRunSummary(args);
  if (name == 'plugin') {
    final action = args['action']?.toString() ?? '';
    final inner = args['args'] is Map ? (args['args'] as Map).cast<String, dynamic>() : <String, dynamic>{};
    if (action == 'install' || action == 'uninstall' || action == 'scaffold' || action == 'build' || action == 'test-load' || action == 'verify') {
      return inner['id']?.toString() ?? '';
    }
    if (action == 'publish') return inner['pluginDir']?.toString() ?? inner['id']?.toString() ?? '';
    if (action == 'tool') return '${args['pluginId'] ?? ''}/${args['tool'] ?? ''}';
    return '';
  }
  if (name == 'ledger') return args['path']?.toString() ?? '';
  if (name == 'session') return args['sessionId']?.toString() ?? '';
  if (name == 'read_file' || name == 'write_file' || name == 'edit_file' || name == 'rollback_file') return args['path']?.toString() ?? '';
  if (name == 'run_command') return args['command']?.toString() ?? '';
  if (name == 'list_dir') return args['path']?.toString() ?? _l.toolCurrentDir;
  if (name == 'image_analyze') {
    final s = args['imageUrl']?.toString() ?? '';
    return s.length > 48 ? s.substring(0, 48) : s;
  }
  if (name == 'computer_action') return args['action']?.toString() ?? '';
  if (name == 'computer_screenshot' || name == 'computer_ocr') return '';
  if (name == 'browser_navigate') return args['url']?.toString() ?? '';
  if (name == 'browser_create') return args['url']?.toString() ?? args['appId']?.toString() ?? '';
  if (name == 'browser_click' || name == 'browser_type' || name == 'browser_wait') return args['selector']?.toString() ?? '';
  if (name == 'browser_get_content') return args['selector']?.toString() ?? '';
  if (name == 'browser_scroll') return args['direction']?.toString() ?? '';
  if (name == 'browser_close' || name == 'browser_list') return args['appId']?.toString() ?? '';
  return '';
}

/// 脱敏：把 token / api key / 密码等敏感字段替换为 ***（对齐桌面端 redactSecret）
String redactSecret(String text) {
  final re1 = RegExp(r'((?:token|api[_-]?key|access_token|authorization|bearer|password|passwd|pwd|secret)\s*[:=]\s*)([^\s"]+)', caseSensitive: false);
  final re2 = RegExp(r'(bearer\s+)([a-zA-Z0-9._-]+)', caseSensitive: false);
  return text.replaceAll(re1, r'$1***').replaceAll(re2, r'$1***');
}

/// 把工具结果转成可读字符串（对齐桌面端 stringifyResult）
String stringifyResult(dynamic result) {
  if (result == null) return '';
  if (result is String) return result;
  try {
    return const JsonEncoder.withIndent('  ').convert(result);
  } catch (_) {
    return result.toString();
  }
}

/// 字符串截断（超出 max 显示「…（共 N 字）」）
String truncateText(String text, int max) {
  if (text.length <= max) return text;
  // 原实现把「…（共 N 字）」直接拼进结果 → 英文会露全角括号且没有单复数，改走词条
  return '${text.substring(0, max)}${_l.toolTruncatedChars(text.length)}';
}

/// 毫秒 → 人类可读耗时（对齐桌面端 formatDuration）
String formatDurationMs(int ms) {
  if (ms < 1000) return '$ms ms';
  if (ms < 60000) return '${(ms / 1000).toStringAsFixed(1)}s';
  final m = ms ~/ 60000;
  final s = ((ms % 60000) / 1000).round();
  return _l.toolMinuteSecond(m, s);
}

/// 安全地把 dynamic 转成 `Map<String, dynamic>`
Map<String, dynamic>? _asMap(dynamic v) => v is Map ? v.cast<String, dynamic>() : null;

// ===== 行级 diff（git diff 风格，移植桌面端 lcsDiff / computeDiff）=====

enum _DiffLineType { context, add, del, fold }

class _DiffLine {
  final _DiffLineType type;
  final String text;
  final int? oldLine;
  final int? newLine;
  /// 折叠行的未变行数。【为什么不把「⋯ N 行未变」算进 text】那是把已取好的文案
  /// 烘进计算结果 —— 结果一旦被缓存（桌面端期2 的 foldCount、期4C 的 banner useMemo
  /// 都是这个坑），切语言后缓存里仍是旧语言。这里只存数字，渲染时才取词。
  final int? foldCount;
  _DiffLine(this.type, this.text, {this.oldLine, this.newLine, this.foldCount});
}

List<_DiffLine> _lcsDiff(List<String> a, List<String> b, int oldStart, int newStart) {
  final n = a.length;
  final m = b.length;
  final dp = List.generate(n + 1, (_) => List<int>.filled(m + 1, 0));
  for (int i = n - 1; i >= 0; i--) {
    for (int j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] == b[j] ? dp[i + 1][j + 1] + 1 : math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  final out = <_DiffLine>[];
  int i = 0;
  int j = 0;
  while (i < n && j < m) {
    if (a[i] == b[j]) {
      out.add(_DiffLine(_DiffLineType.context, a[i], oldLine: oldStart + i, newLine: newStart + j));
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.add(_DiffLine(_DiffLineType.del, a[i], oldLine: oldStart + i));
      i++;
    } else {
      out.add(_DiffLine(_DiffLineType.add, b[j], newLine: newStart + j));
      j++;
    }
  }
  while (i < n) {
    out.add(_DiffLine(_DiffLineType.del, a[i], oldLine: oldStart + i));
    i++;
  }
  while (j < m) {
    out.add(_DiffLine(_DiffLineType.add, b[j], newLine: newStart + j));
    j++;
  }
  return out;
}

List<_DiffLine> _computeDiff(String before, String after) {
  final a = before.split('\n');
  final b = after.split('\n');
  final n = a.length;
  final m = b.length;
  int start = 0;
  while (start < n && start < m && a[start] == b[start]) {
    start++;
  }
  int endA = n;
  int endB = m;
  while (endA > start && endB > start && a[endA - 1] == b[endB - 1]) {
    endA--;
    endB--;
  }
  final lines = <_DiffLine>[];
  for (int i = 0; i < start; i++) {
    lines.add(_DiffLine(_DiffLineType.context, a[i], oldLine: i + 1, newLine: i + 1));
  }
  final midA = a.sublist(start, endA);
  final midB = b.sublist(start, endB);
  if (midA.length > 4000 || midB.length > 4000) {
    for (final t in midA) {
      lines.add(_DiffLine(_DiffLineType.del, t));
    }
    for (final t in midB) {
      lines.add(_DiffLine(_DiffLineType.add, t));
    }
  } else {
    lines.addAll(_lcsDiff(midA, midB, start + 1, start + 1));
  }
  for (int i = 0; i < n - endA; i++) {
    lines.add(_DiffLine(_DiffLineType.context, a[endA + i], oldLine: endA + i + 1, newLine: endB + i + 1));
  }

  const ctx = 3;
  final keep = <int>{};
  for (int i = 0; i < lines.length; i++) {
    final l = lines[i];
    if (l.type == _DiffLineType.add || l.type == _DiffLineType.del) {
      for (int d = -ctx; d <= ctx; d++) {
        final j = i + d;
        if (j >= 0 && j < lines.length) keep.add(j);
      }
    }
  }
  final out = <_DiffLine>[];
  int lastKept = -1;
  for (int i = 0; i < lines.length; i++) {
    if (keep.contains(i)) {
      if (lastKept >= 0 && i - lastKept > 1) {
        out.add(_DiffLine(_DiffLineType.fold, '', foldCount: i - lastKept - 1));
      }
      out.add(lines[i]);
      lastKept = i;
    }
  }
  return out;
}

// ===== 类型化结果渲染 =====

/// 终端结果卡片（对齐桌面端 TerminalBlock；终端块保持深色终端样式）
Widget _terminalBlock(AppColors c, String command, String stdout, String stderr) {
  return Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      if (command.isNotEmpty)
        Container(
          width: double.infinity,
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          color: c.terminalBg,
          child: Text.rich(
            TextSpan(children: [
              TextSpan(text: '\$ ', style: TextStyle(color: c.terminalPrompt)),
              TextSpan(text: command, style: TextStyle(color: c.terminalCmd)),
            ]),
            style: const TextStyle(fontFamily: 'monospace', fontSize: 12, height: 1.5),
          ),
        ),
      if (stdout.isNotEmpty || stderr.isNotEmpty)
        Container(
          width: double.infinity,
          constraints: const BoxConstraints(maxHeight: 280),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          color: c.terminalOut,
          child: SingleChildScrollView(
            child: Text.rich(
              TextSpan(children: [
                TextSpan(text: stdout, style: const TextStyle(color: _kTerminalOutText)),
                if (stderr.isNotEmpty) TextSpan(text: stderr, style: const TextStyle(color: _kTerminalErrText)),
              ]),
              style: const TextStyle(fontFamily: 'monospace', fontSize: 12, height: 1.5),
            ),
          ),
        ),
    ],
  );
}

/// 文件结果卡片：带行号的只读窗口，超 200 行折叠（对齐桌面端 FileBlock）
Widget _fileBlock(AppColors c, String content, String path) {
  final lines = content.split('\n');
  const max = 200;
  final shown = lines.length > max ? lines.sublist(0, max) : lines;
  return Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      if (path.isNotEmpty)
        Container(
          width: double.infinity,
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
          decoration: BoxDecoration(border: Border(bottom: BorderSide(color: c.border))),
          child: Text(
            _l.toolFileHead(path, lines.length),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(fontSize: 11, color: c.textMuted),
          ),
        ),
      ConstrainedBox(
        constraints: const BoxConstraints(maxHeight: 320),
        child: SingleChildScrollView(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              for (int i = 0; i < shown.length; i++)
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    SizedBox(
                      width: 40,
                      child: Text('${i + 1}', textAlign: TextAlign.right, style: TextStyle(fontFamily: 'monospace', fontSize: 12, color: c.textFaint)),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(shown[i].isEmpty ? ' ' : shown[i], style: TextStyle(fontFamily: 'monospace', fontSize: 12, color: c.textPrimary, height: 1.5)),
                    ),
                  ],
                ),
              if (lines.length > max)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                  child: Text(_l.toolFileTruncated(lines.length, max), style: TextStyle(fontSize: 11, color: c.textMuted)),
                ),
            ],
          ),
        ),
      ),
    ],
  );
}

/// 文件变更卡片：git diff 风格（- 红 / + 绿 / 上下文灰）
Widget _diffBlock(AppColors c, String before, String after, String path, bool isNew) {
  final treatAsNew = isNew || before.isEmpty;
  final diffLines = treatAsNew
      ? [for (int i = 0; i < after.split('\n').length; i++) _DiffLine(_DiffLineType.add, after.split('\n')[i], newLine: i + 1)]
      : _computeDiff(before, after);
  final addCount = diffLines.where((l) => l.type == _DiffLineType.add).length;
  final delCount = diffLines.where((l) => l.type == _DiffLineType.del).length;

  return Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      if (path.isNotEmpty)
        Container(
          width: double.infinity,
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
          decoration: BoxDecoration(border: Border(bottom: BorderSide(color: c.border))),
          child: Text(
            // 这句原文【不带「行」】，与审批参数区那句不同 → 各一条词条，硬合并就会改变中文态
            '$path${_l.sepMiddle}${treatAsNew ? _l.toolDiffNewFile(addCount) : _l.toolDiffStatPlain(addCount, delCount)}',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(fontSize: 11, color: c.textMuted),
          ),
        ),
      ConstrainedBox(
        constraints: const BoxConstraints(maxHeight: 360),
        child: SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              for (final l in diffLines) _diffLineRow(c, l),
            ],
          ),
        ),
      ),
    ],
  );
}

Widget _diffLineRow(AppColors c, _DiffLine l) {
  if (l.type == _DiffLineType.fold) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 3),
      color: c.diffFoldBg,
      // 渲染期取词（数字来自 _DiffLine.foldCount）
      child: Text(_l.toolDiffUnchanged(l.foldCount ?? 0), textAlign: TextAlign.center, style: TextStyle(fontSize: 11, color: c.textMuted)),
    );
  }
  final isAdd = l.type == _DiffLineType.add;
  final isDel = l.type == _DiffLineType.del;
  final bg = isAdd ? c.diffAddBg : isDel ? c.diffDelBg : Colors.transparent;
  final sign = isAdd ? '+' : isDel ? '−' : ' ';
  final signColor = isAdd ? c.success : isDel ? c.error : c.textFaint;
  final textColor = isDel ? c.error : isAdd ? c.success : c.textPrimary;
  return Container(
    width: double.infinity,
    color: bg,
    padding: const EdgeInsets.symmetric(vertical: 1),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 34,
          child: Text(l.oldLine?.toString() ?? '', textAlign: TextAlign.right, style: TextStyle(fontFamily: 'monospace', fontSize: 11, color: c.textFaint)),
        ),
        const SizedBox(width: 8),
        SizedBox(
          width: 34,
          child: Text(l.newLine?.toString() ?? '', textAlign: TextAlign.right, style: TextStyle(fontFamily: 'monospace', fontSize: 11, color: c.textFaint)),
        ),
        const SizedBox(width: 8),
        Text(sign, style: TextStyle(fontFamily: 'monospace', fontSize: 12, color: signColor, fontWeight: FontWeight.w600)),
        const SizedBox(width: 8),
        Expanded(
          child: Text(l.text.isEmpty ? ' ' : l.text, style: TextStyle(fontFamily: 'monospace', fontSize: 12, color: textColor, height: 1.4)),
        ),
      ],
    ),
  );
}

/// 从截图结果提取图片 src：优先 https 链接，回退 base64 data URL
String? _screenshotSrc(dynamic result) {
  final r = _asMap(result);
  if (r == null) return null;
  final url = r['imageUrl'];
  if (url is String && url.isNotEmpty) return url;
  final b64 = r['imageBase64'];
  if (b64 is String && b64.isNotEmpty) return 'data:image/png;base64,$b64';
  return null;
}

Widget _imageBlock(String src) {
  final isDataUrl = src.startsWith('data:');
  Widget image;
  if (isDataUrl) {
    try {
      final comma = src.indexOf(',');
      final b64 = comma >= 0 ? src.substring(comma + 1) : src;
      final bytes = base64Decode(b64);
      image = Image.memory(bytes, fit: BoxFit.contain, width: double.infinity, errorBuilder: _imageErrorBuilder);
    } catch (_) {
      return const SizedBox.shrink();
    }
  } else {
    image = Image.network(src, fit: BoxFit.contain, width: double.infinity, errorBuilder: _imageErrorBuilder);
  }
  return ClipRRect(
    borderRadius: BorderRadius.circular(6),
    child: ConstrainedBox(
      constraints: const BoxConstraints(maxHeight: 320),
      child: image,
    ),
  );
}

Widget _imageErrorBuilder(BuildContext context, Object error, StackTrace? stackTrace) {
  final c = context.appColors;
  return Padding(
    padding: const EdgeInsets.all(12),
    child: Text(_l.toolImageLoadFailed, style: TextStyle(fontSize: 12, color: c.textMuted)),
  );
}

/// 纯文本块（脱敏 + 截断）
Widget _textBlock(AppColors c, String text) {
  return Container(
    width: double.infinity,
    constraints: const BoxConstraints(maxHeight: 320),
    padding: const EdgeInsets.all(10),
    color: c.codeBg,
    child: SingleChildScrollView(
      child: Text(text, style: TextStyle(fontFamily: 'monospace', fontSize: 12, color: c.textPrimary, height: 1.5)),
    ),
  );
}

Widget _successBlock(AppColors c, String text) {
  return Padding(
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
    child: Text(text, style: TextStyle(fontSize: 12, color: c.success)),
  );
}

Widget _errorBlock(AppColors c, String error) {
  return Padding(
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
    child: Text(redactSecret(error), style: TextStyle(fontSize: 12, color: c.error, height: 1.5)),
  );
}

/// 按工具类型渲染结果（对齐桌面端 renderToolResult）
Widget? renderToolResult(AppColors c, String name, dynamic result, String? error, Map<String, dynamic>? args) {
  if (error != null && error.isNotEmpty) return _errorBlock(c, error);
  if (result == null) return null;
  if (name == 'run_command') {
    final r = _asMap(result) ?? <String, dynamic>{};
    return _terminalBlock(
      c,
      args?['command']?.toString() ?? '',
      r['stdout']?.toString() ?? '',
      r['stderr']?.toString() ?? '',
    );
  }
  if (name == 'list_dir') {
    return _textBlock(c, result.toString());
  }
  if (name == 'read_file') {
    return _fileBlock(c, result.toString(), args?['path']?.toString() ?? '');
  }
  if (name == 'skill_run' && args?['action'] == 'screenshot') {
    final src = _screenshotSrc(result);
    return src != null ? _imageBlock(src) : null;
  }
  if (name == 'computer_screenshot' || name == 'browser_screenshot') {
    final src = _screenshotSrc(result);
    return src != null ? _imageBlock(src) : null;
  }
  if (name == 'write_file') {
    final r = _asMap(result) ?? <String, dynamic>{};
    if (r['after'] is String) {
      return _diffBlock(c, r['before']?.toString() ?? '', r['after'] as String, r['path']?.toString() ?? '', r['isNew'] == true);
    }
    return _successBlock(c, _l.toolWritten('${r['path'] ?? ''}'));
  }
  if (name == 'edit_file') {
    final r = _asMap(result) ?? <String, dynamic>{};
    if (r['after'] is String) {
      return _diffBlock(c, r['before']?.toString() ?? '', r['after'] as String, r['path']?.toString() ?? '', false);
    }
    return _successBlock(c, _l.toolEdited('${r['path'] ?? ''}'));
  }
  return _textBlock(c, redactSecret(truncateText(stringifyResult(result), 4000)));
}

/// 工具步骤执行状态
enum ToolStepStatus { running, pendingApproval, done, error }

/// 紧凑单行工具执行步骤（对齐桌面端 ToolStep）
class ToolStepWidget extends StatefulWidget {
  final ToolTrace trace;
  const ToolStepWidget({super.key, required this.trace});

  @override
  State<ToolStepWidget> createState() => _ToolStepWidgetState();
}

class _ToolStepWidgetState extends State<ToolStepWidget> {
  bool _expanded = false;
  bool _reasoningOpen = false;

  ToolTrace get trace => widget.trace;
  bool get _isCall => trace.kind == 'tool-call';

  ToolStepStatus get _status {
    if (_isCall) {
      if (trace.approvalRequired && !trace.approved) return ToolStepStatus.pendingApproval;
      return ToolStepStatus.running;
    }
    if (trace.error != null && trace.error!.isNotEmpty) return ToolStepStatus.error;
    return ToolStepStatus.done;
  }

  /// 步骤标题。l 由 build 传入（与 build 里同一次 of(context) 取值，避免一处走
  /// 镜像、一处走 context 而拿到不同语言）。
  String _titleOf(AppLocalizations l) {
    final name = friendlyToolName(trace.name, trace.args);
    if (_status == ToolStepStatus.error) return l.toolFailedTitle(name);
    return name;
  }

  Color _statusColorOf(AppColors c) {
    switch (_status) {
      case ToolStepStatus.running:
        return c.running;
      case ToolStepStatus.pendingApproval:
        return c.pending;
      case ToolStepStatus.error:
        return c.error;
      case ToolStepStatus.done:
        return c.success;
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.appColors;
    // 取词统一走这一次 of(context) 的结果（_titleOf(l) / 下面的标签都用 l），
    // 与 context-free 的 _l 是同一个 LocaleController 推导出来的同一份词。
    //
    // 【为什么不像桌面端那样强调「谁取词谁订阅」】桌面端 React 靠 InheritedWidget
    // 之外的 useSyncExternalStore 才重渲染，漏订阅是真的会停在旧语言（期1/2/3/4A 四次实证）。
    // Flutter 这边本期用 RC1 实测过：把本行换成 _l（完全不登记依赖）后，切语言屏上
    // 文案照样变英文 —— locale 变化会重建整棵页面子树。所以这一行是「统一取值入口」
    // 而不是「防停在旧语言的必要订阅」，注释不能写成后者（那是与实测相反的第二份真相）。
    final l = AppLocalizations.of(context);
    final summary = toolSummary(trace.name, trace.args);
    final resultBody = !_isCall ? renderToolResult(c, trace.name, trace.result, trace.error, trace.args) : null;
    final expandable = resultBody != null;
    final reasoning = trace.reasoning;
    final hasReasoning = reasoning != null && reasoning.isNotEmpty;
    final stateColor = _statusColorOf(c);

    return Padding(
      padding: const EdgeInsets.only(bottom: 3),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // 思考信息：步骤上方，紧凑无边框（先思考、再执行）
          if (hasReasoning) _buildReasoning(c, l, reasoning),
          // 主行：图标 + 粗体标题 + 「·」+ 摘要 + 状态标签 + chevron
          InkWell(
            onTap: expandable ? () => setState(() => _expanded = !_expanded) : null,
            borderRadius: BorderRadius.circular(4),
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 2),
              child: Row(
                children: [
                  Icon(_toolIcon(trace.name), size: 15, color: stateColor),
                  const SizedBox(width: 6),
                  Flexible(
                    child: Row(
                      children: [
                        Flexible(
                          flex: 0,
                          child: Text(_titleOf(l), maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: c.textPrimary)),
                        ),
                        if (summary.isNotEmpty) ...[
                          Text(l.sepMiddle, style: TextStyle(fontSize: 13, color: c.textFaint)),
                          Expanded(
                            child: Text(summary, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 13, color: c.textMuted)),
                          ),
                        ],
                      ],
                    ),
                  ),
                  if (_status == ToolStepStatus.running)
                    Padding(
                      padding: const EdgeInsets.only(left: 6),
                      child: Text(l.toolRunning, style: TextStyle(fontSize: 12, color: c.running)),
                    ),
                  if (_isCall && trace.approvalRequired)
                    Container(
                      margin: const EdgeInsets.only(left: 6),
                      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                      decoration: BoxDecoration(color: c.approvalTagBg, borderRadius: BorderRadius.circular(4)),
                      child: Text(l.toolPendingApproval, style: TextStyle(fontSize: 11, color: c.pending)),
                    ),
                  if (expandable)
                    Padding(
                      padding: const EdgeInsets.only(left: 6),
                      child: AnimatedRotation(
                        turns: _expanded ? 0.5 : 0,
                        duration: const Duration(milliseconds: 150),
                        child: Icon(Icons.expand_more, size: 16, color: c.textFaint),
                      ),
                    ),
                ],
              ),
            ),
          ),
          // 展开结果：左侧竖线缩进 + 类型化结果
          if (_expanded && expandable)
            Container(
              margin: const EdgeInsets.only(top: 3, left: 18),
              padding: const EdgeInsets.only(left: 0),
              decoration: BoxDecoration(border: Border(left: BorderSide(color: c.border, width: 2))),
              child: resultBody,
            ),
        ],
      ),
    );
  }

  Widget _buildReasoning(AppColors c, AppLocalizations l, String reasoning) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 3),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          InkWell(
            onTap: () => setState(() => _reasoningOpen = !_reasoningOpen),
            child: Row(
              children: [
                AnimatedRotation(
                  turns: _reasoningOpen ? 0 : -0.25,
                  duration: const Duration(milliseconds: 150),
                  child: Icon(Icons.expand_more, size: 15, color: c.textFaint),
                ),
                const SizedBox(width: 2),
                Text(l.toolThinking, style: TextStyle(fontSize: 12, color: c.textFaint)),
              ],
            ),
          ),
          if (_reasoningOpen)
            Container(
              margin: const EdgeInsets.only(top: 2),
              padding: const EdgeInsets.only(left: 10),
              decoration: BoxDecoration(border: Border(left: BorderSide(color: c.border, width: 2))),
              constraints: const BoxConstraints(maxHeight: 200),
              child: SingleChildScrollView(
                child: Text(reasoning, style: TextStyle(fontSize: 12, color: c.textMuted, height: 1.6)),
              ),
            ),
        ],
      ),
    );
  }
}

/// 统计工具步骤执行情况（对齐桌面端 toolStepStats）
({int total, int success, int failed, int running}) toolStepStats(List<ToolTrace> tools) {
  int success = 0;
  int failed = 0;
  int running = 0;
  for (final t in tools) {
    if (t.kind == 'tool-call') {
      running++;
    } else if (t.error != null && t.error!.isNotEmpty) {
      failed++;
    } else {
      success++;
    }
  }
  return (total: tools.length, success: success, failed: failed, running: running);
}

/// 风险等级 → 中文文案（对齐桌面端 riskLevelLabel，不暴露英文枚举值）
String riskLevelLabel(String level) {
  // 表里存闭包（同一个坑的第十一次）；措辞与桌面端 chat.risk.* 逐字一致
  final loc = _l;
  const map = <String, L10nText>{
    'readonly': _riskReadonly,
    'reversible': _riskReversible,
    'irreversible': _riskIrreversible,
    'high': _riskHigh,
  };
  return (map[level] ?? (level.isEmpty ? (l) => l.riskNormal : (l) => level))(loc);
}

// 风险等级取词闭包（const 表里要放常量表达式，故提到顶层函数而不是内联 lambda）
String _riskReadonly(AppLocalizations l) => l.riskReadonly;
String _riskReversible(AppLocalizations l) => l.riskReversible;
String _riskIrreversible(AppLocalizations l) => l.riskIrreversible;
String _riskHigh(AppLocalizations l) => l.riskHigh;

/// 审批弹窗参数友好渲染（对齐桌面端 renderApprovalDetail 的精简版）：
/// 命令→终端块、写/编辑文件→路径 + 变更规模、其余→友好键值对（长值截断），
/// 避免把整个 args map 直接 dump 出来撑大弹窗。
Widget approvalArgsWidget(AppColors c, String name, Map<String, dynamic> args) {
  if (args.isEmpty) {
    return Text(_l.toolNoArgs, style: TextStyle(fontSize: 12, color: c.textMuted));
  }
  // 执行命令：完整显示命令（通常一行，是审批的关键信息）
  if (name == 'run_command') {
    final cmd = args['command']?.toString() ?? '';
    if (cmd.isNotEmpty) {
      return Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
        decoration: BoxDecoration(color: c.terminalBg, borderRadius: BorderRadius.circular(6)),
        child: Text.rich(
          TextSpan(children: [
            TextSpan(text: '\$ ', style: TextStyle(color: c.terminalPrompt)),
            TextSpan(text: cmd, style: TextStyle(color: c.terminalCmd)),
          ]),
          style: const TextStyle(fontFamily: 'monospace', fontSize: 12, height: 1.4),
        ),
      );
    }
  }
  // 写入/编辑文件：只显示路径 + 变更规模，正文大段代码不再撑爆弹窗
  if (name == 'write_file' || name == 'edit_file') {
    final path = args['path']?.toString() ?? '';
    final before = name == 'edit_file' ? (args['oldText']?.toString() ?? '') : '';
    final after = name == 'write_file' ? (args['content']?.toString() ?? '') : (args['newText']?.toString() ?? '');
    final addLines = after.isEmpty ? 0 : after.split('\n').length;
    final delLines = before.isEmpty ? 0 : before.split('\n').length;
    final isNew = name == 'write_file';
    final head = path.isNotEmpty
        // 审批参数区这两句原文【带「行」】，与 diff 卡片首行不是同一句 → 各一条词条
        ? '$path${_l.sepMiddle}${isNew ? _l.toolApprovalNewFile(addLines) : _l.toolApprovalStat(addLines, delLines)}'
        : (isNew ? _l.toolApprovalNewFileFull(addLines) : _l.toolApprovalStat(addLines, delLines));
    return Text(head, maxLines: 3, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 12, color: c.textPrimary, fontFamily: 'monospace', height: 1.4));
  }
  // 其余：友好键值对，长值截断
  return _argsKvWidget(c, args);
}

/// 友好键值对（对齐桌面端 formatArgs）：key 灰、value 主色，长值截断
Widget _argsKvWidget(AppColors c, Map<String, dynamic> args) {
  final entries = args.entries.toList();
  return Column(
    mainAxisSize: MainAxisSize.min,
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      for (final e in entries)
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 1.5),
          child: Text.rich(
            TextSpan(children: [
              TextSpan(text: _l.argsLabelLine(e.key), style: TextStyle(color: c.textMuted)),
              TextSpan(text: _prettyArg(e.value), style: TextStyle(color: c.textPrimary)),
            ]),
            style: const TextStyle(fontSize: 12, height: 1.5),
          ),
        ),
    ],
  );
}

/// 参数值截断（对齐桌面端 prettyValue，长字符串截断避免撑大弹窗）
String _prettyArg(dynamic v) {
  String s;
  if (v is String) {
    s = v;
  } else {
    try {
      s = const JsonEncoder().convert(v);
    } catch (_) {
      s = v.toString();
    }
  }
  return s.length > 200 ? '${s.substring(0, 200)}…' : s;
}
