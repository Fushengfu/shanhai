import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import '../models/protocol.dart';
import '../theme.dart';
import 'tool_step.dart';

/// 消息气泡渲染（对齐桌面端 UserMessage / AssistantMessage / ReasoningBlock）。
/// - 用户气泡：右对齐、主题紫底白字、右下小角。
/// - 助手气泡：左对齐、左上小角、顶部「耗时 + 步数统计」、工具步骤紧凑、思考过程可折叠、正文 Markdown。
/// 颜色统一走 context.appColors（亮/暗主题切换自动刷新）。

/// 用户消息气泡（右对齐、紫底白字、右下小角）。
/// 长按弹出操作菜单：复制 / 重新生成（重试）/ 编辑并重发（对齐桌面端 UserMessage 的操作）。
class UserBubble extends StatelessWidget {
  final String content;
  /// 重新生成（resend 原内容，不带 newContent）
  final VoidCallback? onResend;
  /// 编辑并重发（resend 带 newContent）
  final ValueChanged<String>? onEdit;

  const UserBubble({super.key, required this.content, this.onResend, this.onEdit});

  Future<void> _showMenu(BuildContext context) async {
    final c = context.appColors;
    final action = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: c.bottomSheetBg,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(16))),
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: Icon(Icons.copy_outlined, size: 20, color: c.textPrimary),
              title: Text('复制', style: TextStyle(color: c.textPrimary)),
              onTap: () => Navigator.pop(ctx, 'copy'),
            ),
            if (onResend != null)
              ListTile(
                leading: Icon(Icons.refresh, size: 20, color: c.textPrimary),
                title: Text('重新生成', style: TextStyle(color: c.textPrimary)),
                onTap: () => Navigator.pop(ctx, 'resend'),
              ),
            if (onEdit != null)
              ListTile(
                leading: Icon(Icons.edit_outlined, size: 20, color: c.textPrimary),
                title: Text('编辑并重发', style: TextStyle(color: c.textPrimary)),
                onTap: () => Navigator.pop(ctx, 'edit'),
              ),
          ],
        ),
      ),
    );
    if (action == null) return;
    if (!context.mounted) return;
    if (action == 'copy') {
      await Clipboard.setData(ClipboardData(text: content));
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已复制')));
      }
    } else if (action == 'resend') {
      onResend?.call();
    } else if (action == 'edit') {
      await _promptEdit(context);
    }
  }

  Future<void> _promptEdit(BuildContext context) async {
    final ctrl = TextEditingController(text: content);
    final newContent = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('编辑并重发'),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          minLines: 2,
          maxLines: 6,
          decoration: const InputDecoration(hintText: '修改后重新发送'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          TextButton(onPressed: () => Navigator.pop(ctx, ctrl.text.trim()), child: const Text('发送')),
        ],
      ),
    );
    ctrl.dispose();
    if (newContent != null && newContent.isNotEmpty) {
      onEdit?.call(newContent);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.appColors;
    return GestureDetector(
      onLongPress: () => _showMenu(context),
      child: Align(
        alignment: Alignment.centerRight,
        child: Container(
          margin: const EdgeInsets.symmetric(vertical: 6),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.78),
          decoration: BoxDecoration(
            color: c.bubbleUser,
            borderRadius: const BorderRadius.only(topLeft: Radius.circular(16), topRight: Radius.circular(16), bottomLeft: Radius.circular(16), bottomRight: Radius.circular(4)),
          ),
          child: Text(content, style: const TextStyle(fontSize: 15, color: Colors.white, height: 1.5)),
        ),
      ),
    );
  }
}

/// 「思考过程」折叠区块（对齐桌面端 ReasoningBlock：无边框、左细线 + 折叠文字）
class ReasoningSection extends StatefulWidget {
  final String content;
  final bool streaming;
  const ReasoningSection({super.key, required this.content, this.streaming = false});

  @override
  State<ReasoningSection> createState() => _ReasoningSectionState();
}

class _ReasoningSectionState extends State<ReasoningSection> {
  late bool _open = widget.streaming;

  @override
  Widget build(BuildContext context) {
    final c = context.appColors;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        InkWell(
          onTap: () => setState(() => _open = !_open),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 2),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                AnimatedRotation(
                  turns: _open ? 0 : -0.25,
                  duration: const Duration(milliseconds: 150),
                  child: Icon(Icons.expand_more, size: 15, color: c.textMuted),
                ),
                const SizedBox(width: 2),
                Text(widget.streaming ? '正在思考…' : '思考过程', style: TextStyle(fontSize: 12, color: c.textMuted)),
              ],
            ),
          ),
        ),
        if (_open)
          Container(
            margin: const EdgeInsets.only(top: 2),
            padding: const EdgeInsets.only(left: 10),
            decoration: BoxDecoration(border: Border(left: BorderSide(color: c.border, width: 2))),
            constraints: const BoxConstraints(maxHeight: 240),
            child: SingleChildScrollView(
              child: Text(
                widget.content,
                style: TextStyle(fontSize: 12, color: c.textMuted, height: 1.6),
              ),
            ),
          ),
      ],
    );
  }
}

/// 助手消息气泡（左对齐、左上小角、顶部耗时 + 步数统计、工具步骤、思考过程、正文）
class AssistantBubble extends StatelessWidget {
  final String content;
  final String? reasoning;
  final List<ToolTrace> toolSteps;
  final int? turnDuration;
  final bool thinking;

  const AssistantBubble({
    super.key,
    required this.content,
    this.reasoning,
    this.toolSteps = const [],
    this.turnDuration,
    this.thinking = false,
  });

  @override
  Widget build(BuildContext context) {
    final c = context.appColors;
    final hasContent = content.isNotEmpty;
    final hasReasoning = reasoning != null && reasoning!.isNotEmpty;
    final hasTools = toolSteps.isNotEmpty;

    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 6),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.88),
        decoration: BoxDecoration(
          color: c.bubbleAi,
          borderRadius: const BorderRadius.only(topLeft: Radius.circular(4), topRight: Radius.circular(16), bottomLeft: Radius.circular(16), bottomRight: Radius.circular(16)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // 顶部：耗时 + 步数统计（对齐桌面端 StepStats，无工具步骤且无耗时时不渲染）
            if (turnDuration != null || hasTools) _buildStats(c),
            // 工具执行步骤（紧凑单行）
            if (hasTools) ...[
              const SizedBox(height: 2),
              for (final t in toolSteps) ToolStepWidget(trace: t),
            ],
            // 思考过程（可折叠，流式时默认展开并显示「正在思考…」）
            if (hasReasoning) ReasoningSection(content: reasoning!, streaming: thinking),
            // 正式回答
            if (hasContent)
              Padding(
                padding: EdgeInsets.only(top: hasTools ? 6 : 0),
                child: MarkdownBody(
                  data: content,
                  selectable: true,
                  styleSheet: _markdownStyle(c),
                ),
              ),
            // 思考中占位
            if (!hasContent && !hasReasoning && thinking)
              Row(
                children: [
                  const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)),
                  const SizedBox(width: 8),
                  Text('思考中…', style: TextStyle(fontSize: 13, color: Colors.grey.shade500)),
                ],
              ),
          ],
        ),
      ),
    );
  }

  Widget _buildStats(AppColors c) {
    final stats = toolStepStats(toolSteps);
    final spans = <TextSpan>[];
    void sep() => spans.add(const TextSpan(text: ' · '));
    if (turnDuration != null) {
      spans.add(TextSpan(text: '耗时 ${formatDurationMs(turnDuration!)}'));
    }
    if (stats.total > 0) {
      if (spans.isNotEmpty) sep();
      spans.add(TextSpan(text: '${stats.total} 步'));
      if (stats.success > 0) {
        sep();
        spans.add(TextSpan(text: '${stats.success} 成功', style: TextStyle(color: c.success)));
      }
      if (stats.failed > 0) {
        sep();
        spans.add(TextSpan(text: '${stats.failed} 失败', style: TextStyle(color: c.error)));
      }
      if (stats.running > 0) {
        sep();
        spans.add(TextSpan(text: '${stats.running} 执行中', style: TextStyle(color: c.running)));
      }
    }
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Text.rich(TextSpan(children: spans), style: TextStyle(fontSize: 11, color: c.textFaint)),
    );
  }
}

/// Markdown 样式（跟随当前主题语义色：代码/引用块适配亮暗气泡背景）
MarkdownStyleSheet _markdownStyle(AppColors c) {
  return MarkdownStyleSheet(
    p: TextStyle(fontSize: 15, height: 1.5, color: c.textPrimary),
    code: TextStyle(
      fontSize: 13,
      fontFamily: 'monospace',
      backgroundColor: c.inputBg,
      color: c.codeText,
    ),
    codeblockDecoration: BoxDecoration(
      color: c.codeBg,
      borderRadius: BorderRadius.circular(8),
      border: Border.all(color: c.border),
    ),
    codeblockPadding: const EdgeInsets.all(10),
    blockquoteDecoration: BoxDecoration(
      color: c.bubbleAi,
      border: Border(left: BorderSide(color: c.bubbleUser, width: 3)),
    ),
    blockquotePadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
  );
}
