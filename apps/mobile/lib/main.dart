import 'package:flutter/material.dart';
import 'theme.dart';
import 'pages/startup_page.dart';

void main() {
  runApp(const ShanhaiMobileApp());
}

class ShanhaiMobileApp extends StatefulWidget {
  const ShanhaiMobileApp({super.key});

  @override
  State<ShanhaiMobileApp> createState() => _ShanhaiMobileAppState();
}

class _ShanhaiMobileAppState extends State<ShanhaiMobileApp> {
  @override
  void initState() {
    super.initState();
    // 启动时读取持久化的主题偏好（跟随系统 / 亮色 / 暗色）
    ThemeController.instance.ensureInitialized();
  }

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<AppThemeMode>(
      valueListenable: ThemeController.instance,
      builder: (context, mode, _) => MaterialApp(
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
        // 主题切换：theme=亮色 / darkTheme=暗色 / themeMode=偏好（跟随系统时自动随系统亮暗）
        theme: AppTheme.light,
        darkTheme: AppTheme.dark,
        themeMode: mode.toThemeMode,
        home: const StartupPage(),
      ),
    );
  }
}
