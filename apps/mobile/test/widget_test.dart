import 'package:flutter_test/flutter_test.dart';

import 'package:shanhai_mobile/main.dart';

void main() {
  testWidgets('App 启动显示登录页', (WidgetTester tester) async {
    await tester.pumpWidget(const ShanhaiMobileApp());
    // 登录页标题「山海」应存在，且有「登录并连接」按钮
    expect(find.text('山海'), findsOneWidget);
    expect(find.text('登录并连接'), findsOneWidget);
  });
}
