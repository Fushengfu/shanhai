import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import '../models/protocol.dart';
import 'tool_step.dart';

/// 消息气泡渲染（对齐桌面端 UserMessage / AssistantMessage / ReasoningBlock）。
/// - 用户气泡：右对齐、主题紫底白字、右下小角。
/// - 助手气泡：左对齐、左上小角、顶部「耗时 + 步数统计」、工具步骤紧凑、思考过程可折叠、正文 Markdown。

const Color _cAccent = Color(0xFF8B5CF6); // 用户气泡主色（手机端 primary 紫）
const Color _cAssistantBg = Color(0xFF1A1A24); // 助手气泡背景
const Color _cText = Color(0xFFE0E0E0);
const Color _cTextMuted = Color(0xFF808080);
const Color _cTextFaint = Color(0xFF5A5A5A);
const Color _cBorder = Color(0xFF3A3A3C);
const Color _cRunning = Color(0xFF22D3EE);
const Color _cSuccess = Color(0xFF34D399);
const Color _cError = Color(0xFFF87171);

/// 用户消息气泡（右对齐、紫底白字、右下小角）
class UserBubble extends StatelessWidget {
  final String content;
  const UserBubble({super.key, required this.content});

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.centerRight,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 6),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.78),
        decoration: const BoxDecoration(
          color: _cAccent,
          borderRadius: BorderRadius.only(topLeft: Radius.circular(16), topRight: Radius.circular(16), bottomLeft: Radius.circular(16), bottomRight: Radius.circular(4)),
        ),
        child: Text(content, style: const TextStyle(fontSize: 15, color: Colors.white, height: 1.5)),
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
                  child: const Icon(Icons.expand_more, size: 15, color: _cTextMuted),
                ),
                const SizedBox(width: 2),
                Text(widget.streaming ? '正在思考…' : '思考过程', style: const TextStyle(fontSize: 12, color: _cTextMuted)),
              ],
            ),
          ),
        ),
        if (_open)
          Container(
            margin: const EdgeInsets.only(top: 2),
            padding: const EdgeInsets.only(left: 10),
            decoration: const BoxDecoration(border: Border(left: BorderSide(color: _cBorder, width: 2))),
            constraints: const BoxConstraints(maxHeight: 240),
            child: SingleChildScrollView(
              child: Text(
                widget.content,
                style: const TextStyle(fontSize: 12, color: _cTextMuted, height: 1.6),
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
    final hasContent = content.isNotEmpty;
    final hasReasoning = reasoning != null && reasoning!.isNotEmpty;
    final hasTools = toolSteps.isNotEmpty;

    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 6),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.88),
        decoration: const BoxDecoration(
          color: _cAssistantBg,
          borderRadius: BorderRadius.only(topLeft: Radius.circular(4), topRight: Radius.circular(16), bottomLeft: Radius.circular(16), bottomRight: Radius.circular(16)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // 顶部：耗时 + 步数统计（对齐桌面端 StepStats，无工具步骤且无耗时时不渲染）
            if (turnDuration != null || hasTools) _buildStats(),
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
                  styleSheet: _markdownStyle(),
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

  Widget _buildStats() {
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
        spans.add(TextSpan(text: '${stats.success} 成功', style: const TextStyle(color: _cSuccess)));
      }
      if (stats.failed > 0) {
        sep();
        spans.add(TextSpan(text: '${stats.failed} 失败', style: const TextStyle(color: _cError)));
      }
      if (stats.running > 0) {
        sep();
        spans.add(TextSpan(text: '${stats.running} 执行中', style: const TextStyle(color: _cRunning)));
      }
    }
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Text.rich(TextSpan(children: spans), style: const TextStyle(fontSize: 11, color: _cTextFaint)),
    );
  }
}

/// 深色主题下的 Markdown 样式（代码块/引用块适配深色气泡背景）
MarkdownStyleSheet _markdownStyle() {
  return MarkdownStyleSheet(
    p: const TextStyle(fontSize: 15, height: 1.5, color: _cText),
    code: const TextStyle(
      fontSize: 13,
      fontFamily: 'monospace',
      backgroundColor: Color(0xFF2A2A3A),
      color: Color(0xFF7DD3FC),
    ),
    codeblockDecoration: BoxDecoration(
      color: const Color(0xFF14141C),
      borderRadius: BorderRadius.circular(8),
      border: Border.all(color: const Color(0xFF2A2A3A)),
    ),
    codeblockPadding: const EdgeInsets.all(10),
    blockquoteDecoration: const BoxDecoration(
      color: Color(0xFF1A1A24),
      border: Border(left: BorderSide(color: Color(0xFF8B5CF6), width: 3)),
    ),
    blockquotePadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
  );
}
