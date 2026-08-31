import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shanhai_mobile/models/protocol.dart';
import 'package:shanhai_mobile/services/ws_client.dart';
import 'package:shanhai_mobile/widgets/chat_view.dart';

/// 验证「进入会话后自动定位到最新消息」：
/// 修复前列表用正向 + animateTo(maxScrollExtent) 定位，动态高度懒加载下滚不到位；
/// 修复后改用 reverse 布局，视觉底部即最新消息，进页天然停在最新位置。
void main() {
  testWidgets('进入会话后自动定位到最新消息（最新可见、最旧不渲染）', (WidgetTester tester) async {
    // 60 条正序历史：index 59 为最新
    final items = List<HistoryItem>.generate(
      60,
      (i) => UserItem(content: '消息 $i', attachments: const [], turnSeq: i),
    );

    await tester.pumpWidget(
      MaterialApp(
        home: ChatView(
          ws: WsClient(),
          sessionId: 's1',
          title: '测试会话',
          sendFn: (_) async => CmdResult(true, null, null),
          loadHistoryFn: ({int? sinceTurnSeq, int? beforeTurnSeq}) async =>
              HistoryResponse(items: items, truncated: false),
        ),
      ),
    );

    // 等待历史加载（异步 setState）+ post-frame 滚动回调完成
    await tester.pumpAndSettle();

    // 1) 列表应为 reverse 布局（本次修复的核心）
    final listView = tester.widget<ListView>(find.byType(ListView));
    expect(listView.reverse, isTrue);

    // 2) 最新消息应在视口内可见（列表停在最新位置，而非停在顶部）
    expect(find.text('消息 59'), findsOneWidget);

    // 3) 最旧消息不应被渲染（在视觉顶部之外，懒加载未构建 → 证明列表没有停在最旧处）
    expect(find.text('消息 0'), findsNothing);
  });
}
