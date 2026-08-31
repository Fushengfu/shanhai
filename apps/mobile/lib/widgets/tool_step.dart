import 'dart:convert';
import 'dart:math' as math;
import 'package:flutter/material.dart';
import '../models/protocol.dart';
import '../theme.dart';

/// 工具执行步骤渲染：紧凑单行摘要 + 折叠的类型化结果卡片（对齐桌面端 ToolStep.tsx）。
/// 桌面端核心特征：无边框无卡片、图标（状态色）+ 粗体标题 + 「·」+ 摘要 + 状态标签；
/// 展开后左侧竖线缩进，结果按工具类型渲染（终端/文件行号/git diff/树形/截图/纯文本）。
/// 颜色统一走 AppColors（亮/暗主题切换自动刷新）；终端/代码块保持深色终端样式（与桌面端一致）。

// 终端深色块固定色（亮暗主题下终端都保持深色终端样式）
const Color _kTerminalOutText = Color(0xFFD4D4D4); // 终端输出正文
const Color _kTerminalErrText = Color(0xFFF48771); // 终端 stderr（红）

/// 工具名 → 中文显示名（对齐桌面端 TOOL_META，避免暴露英文原始名）
const Map<String, String> _toolNameMap = {
  'read_file': '读取文件',
  'write_file': '写入文件',
  'edit_file': '编辑文件',
  'run_command': '执行命令',
  'list_dir': '列出目录',
  'image_analyze': '识别图片',
  'computer_screenshot': '屏幕截图',
  'computer_ocr': '文字识别',
  'computer_action': '电脑操作',
  'browser_create': '创建浏览器窗口',
  'browser_list': '列出浏览器窗口',
  'browser_navigate': '打开网页',
  'browser_close': '关闭浏览器窗口',
  'browser_screenshot': '网页截图',
  'browser_get_info': '读取页面信息',
  'browser_get_content': '读取页面内容',
  'browser_evaluate': '执行页面脚本',
  'browser_click': '点击页面元素',
  'browser_type': '页面输入',
  'browser_scroll': '滚动页面',
  'browser_wait': '等待元素',
  'browser_get_console_logs': '查看控制台日志',
  'browser_get_network_requests': '查看网络请求',
  'browser_get_cookies': '读取 Cookie',
  'browser_set_cookie': '设置 Cookie',
  'browser_clear_cookies': '清除 Cookie',
  'rollback_file': '回滚文件',
  'remember': '保存记忆',
  'recall_memory': '召回记忆',
  'plugin_inspect': '查看自修改',
  'plugin_define': '定义动态包',
  'plugin_run': '运行动态包',
  'plugin_stop': '停止动态包',
  'plugin_undefine': '删除动态包',
  'plugin_test': '测试动态包',
  'plugin_install': '安装动态包',
  'plugin_uninstall': '卸载动态包',
  'list_sessions': '查看会话列表',
  'inspect_session': '查看会话详情',
  'list_models': '查看可用模型',
  'switch_session': '切换激活会话',
  'send_message': '给会话下发任务',
  'inject_message': '给会话追加需求',
  'set_session_model': '切换会话模型',
  'set_session_approval': '配置会话安全模式',
  'set_session_workdir': '设置会话工作目录',
  'create_session': '新建会话',
  'rename_session': '重命名会话',
  'delete_session': '删除会话',
  'choose_session': '选择会话',
  'choose_model': '选择模型',
  'ask_user': '向用户提问',
  'mcp_list_tools': '查看 MCP 工具',
  'mcp_call': '调用 MCP 工具',
  'skill_list': '查看技能列表',
  'skill_read': '查看技能详情',
  'terminal_create': '创建终端',
  'terminal_run': '终端执行命令',
  'terminal_list': '列出终端',
  'terminal_close': '关闭终端',
  'list_ledger': '查看台账目录',
  'read_ledger': '读取台账',
  'write_ledger': '写入台账',
  'edit_ledger': '编辑台账',
  'answer_ask': '代答提问',
  'resolve_approval': '决策审批',
};

/// skill_run 的 skillId:action → 中文显示名
const Map<String, String> _skillActionNameMap = {
  'computer-use:screenshot': '屏幕截图',
  'computer-use:ocr': '文字识别',
  'computer-use:action': '电脑操作',
  'browser-use:create': '创建浏览器窗口',
  'browser-use:list': '列出浏览器窗口',
  'browser-use:navigate': '打开网页',
  'browser-use:close': '关闭浏览器窗口',
  'browser-use:screenshot': '网页截图',
  'browser-use:get_info': '读取页面信息',
  'browser-use:get_content': '读取页面内容',
  'browser-use:evaluate': '执行页面脚本',
  'browser-use:click': '点击页面元素',
  'browser-use:type': '页面输入',
  'browser-use:scroll': '滚动页面',
  'browser-use:wait': '等待元素',
  'browser-use:get_console_logs': '查看控制台日志',
  'browser-use:get_network_requests': '查看网络请求',
  'browser-use:get_cookies': '读取 Cookie',
  'browser-use:set_cookie': '设置 Cookie',
  'browser-use:clear_cookies': '清除 Cookie',
};

/// 工具名 → 中文显示名（skill_run 按 skillId+action 细分，未知名回退「工具操作」）
String friendlyToolName(String name, Map<String, dynamic>? args) {
  if (name == 'skill_run') {
    final skillId = args?['skillId']?.toString() ?? '';
    final action = args?['action']?.toString() ?? '';
    return _skillActionNameMap['$skillId:$action'] ?? '执行技能';
  }
  return _toolNameMap[name] ?? '工具操作';
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
    case 'plugin_inspect':
    case 'plugin_define':
    case 'plugin_run':
    case 'plugin_stop':
    case 'plugin_undefine':
    case 'plugin_test':
    case 'plugin_install':
    case 'plugin_uninstall':
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
    case 'list_ledger':
    case 'read_ledger':
    case 'write_ledger':
    case 'edit_ledger':
      return Icons.book_outlined;
    case 'answer_ask':
      return Icons.question_answer_outlined;
    case 'resolve_approval':
      return Icons.fact_check_outlined;
    case 'list_sessions':
    case 'inspect_session':
      return Icons.people_outline;
    case 'list_models':
      return Icons.memory;
    case 'switch_session':
      return Icons.sync;
    case 'send_message':
    case 'inject_message':
      return Icons.send;
    case 'set_session_approval':
      return Icons.shield_outlined;
    case 'create_session':
      return Icons.add;
    case 'rename_session':
      return Icons.edit_outlined;
    case 'delete_session':
      return Icons.delete_outline;
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
  if (name == 'read_file' || name == 'write_file' || name == 'edit_file' || name == 'rollback_file') return args['path']?.toString() ?? '';
  if (name == 'run_command') return args['command']?.toString() ?? '';
  if (name == 'list_dir') return args['path']?.toString() ?? '当前目录';
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
  return '${text.substring(0, max)}…（共 ${text.length} 字）';
}

/// 毫秒 → 人类可读耗时（对齐桌面端 formatDuration）
String formatDurationMs(int ms) {
  if (ms < 1000) return '$ms ms';
  if (ms < 60000) return '${(ms / 1000).toStringAsFixed(1)}s';
  final m = ms ~/ 60000;
  final s = ((ms % 60000) / 1000).round();
  return '$m分$s秒';
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
  _DiffLine(this.type, this.text, {this.oldLine, this.newLine});
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
        out.add(_DiffLine(_DiffLineType.fold, '⋯ ${i - lastKept - 1} 行未变'));
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
            '$path · ${lines.length} 行',
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
                  child: Text('… 共 ${lines.length} 行，仅显示前 $max 行', style: TextStyle(fontSize: 11, color: c.textMuted)),
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
            '$path · ${treatAsNew ? '新建文件，+$addCount' : '+$addCount −$delCount'}',
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
      child: Text(l.text, textAlign: TextAlign.center, style: TextStyle(fontSize: 11, color: c.textMuted)),
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
    child: Text('图片加载失败', style: TextStyle(fontSize: 12, color: c.textMuted)),
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
    return _successBlock(c, '✓ 已写入 ${r['path'] ?? ''}');
  }
  if (name == 'edit_file') {
    final r = _asMap(result) ?? <String, dynamic>{};
    if (r['after'] is String) {
      return _diffBlock(c, r['before']?.toString() ?? '', r['after'] as String, r['path']?.toString() ?? '', false);
    }
    return _successBlock(c, '✓ 已编辑 ${r['path'] ?? ''}');
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

  String get _title {
    final name = friendlyToolName(trace.name, trace.args);
    if (_status == ToolStepStatus.error) return '$name · 失败';
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
          if (hasReasoning) _buildReasoning(c, reasoning),
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
                          child: Text(_title, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: c.textPrimary)),
                        ),
                        if (summary.isNotEmpty) ...[
                          Text(' · ', style: TextStyle(fontSize: 13, color: c.textFaint)),
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
                      child: Text('执行中…', style: TextStyle(fontSize: 12, color: c.running)),
                    ),
                  if (_isCall && trace.approvalRequired)
                    Container(
                      margin: const EdgeInsets.only(left: 6),
                      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                      decoration: BoxDecoration(color: c.approvalTagBg, borderRadius: BorderRadius.circular(4)),
                      child: Text('待确认', style: TextStyle(fontSize: 11, color: c.pending)),
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

  Widget _buildReasoning(AppColors c, String reasoning) {
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
                Text('思考', style: TextStyle(fontSize: 12, color: c.textFaint)),
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
  const map = {
    'readonly': '只读',
    'reversible': '可逆修改',
    'irreversible': '不可逆操作',
    'high': '高风险',
  };
  return map[level] ?? (level.isEmpty ? '普通' : level);
}

/// 审批弹窗参数友好渲染（对齐桌面端 renderApprovalDetail 的精简版）：
/// 命令→终端块、写/编辑文件→路径 + 变更规模、其余→友好键值对（长值截断），
/// 避免把整个 args map 直接 dump 出来撑大弹窗。
Widget approvalArgsWidget(AppColors c, String name, Map<String, dynamic> args) {
  if (args.isEmpty) {
    return Text('（无参数）', style: TextStyle(fontSize: 12, color: c.textMuted));
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
        ? '$path · ${isNew ? '新建，+$addLines 行' : '+$addLines −$delLines 行'}'
        : (isNew ? '新建文件，+$addLines 行' : '+$addLines −$delLines 行');
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
              TextSpan(text: '${e.key}：', style: TextStyle(color: c.textMuted)),
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
