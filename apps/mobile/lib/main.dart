import 'package:flutter/material.dart';
import 'pages/startup_page.dart';

void main() {
  runApp(const ShanhaiMobileApp());
}

class ShanhaiMobileApp extends StatelessWidget {
  const ShanhaiMobileApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '山海',
      debugShowCheckedModeBanner: false,
      // 锁定文字缩放：华为等机型系统开启「大字体」后，MediaQuery 的 textScaler 会把
      // 全 App 文字（含弹窗）按比例放大，导致弹窗文案显得「很大」。这里统一钳制为 1.0，
      // 保证 UI 按设计稿字号显示，不受系统字体缩放影响。
      builder: (context, child) {
        return MediaQuery(
          data: MediaQuery.of(context).copyWith(textScaler: TextScaler.noScaling),
          child: child!,
        );
      },
      theme: ThemeData(
        brightness: Brightness.dark,
        scaffoldBackgroundColor: const Color(0xFF0E0E14),
        colorScheme: const ColorScheme.dark(
          primary: Color(0xFF8B5CF6),
          secondary: Color(0xFF22D3EE),
          surface: Color(0xFF16161F),
        ),
        useMaterial3: true,
        // 列表项（弹窗选项/设备选择/会话项）统一紧凑：默认 ListTile title 16、subtitle 14
        // 在弹窗里显得偏大，这里收紧为 14/12 并 dense，避免「选项文案很大」。
        listTileTheme: const ListTileThemeData(
          dense: true,
          visualDensity: VisualDensity.compact,
          titleTextStyle: TextStyle(fontSize: 14, color: Color(0xFFE0E0E0)),
          subtitleTextStyle: TextStyle(fontSize: 12, color: Color(0xFF808080)),
        ),
        checkboxTheme: const CheckboxThemeData(
          visualDensity: VisualDensity.compact,
        ),
      ),
      home: const StartupPage(),
    );
  }
}
