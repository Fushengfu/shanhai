import 'package:flutter/material.dart';
import 'l10n/generated/app_localizations.dart';
import 'locale.dart';
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
    // 语言偏好（i18n 期7A）：跟随系统 / 简体中文 / English。
    // 读失败静默回退「跟随系统」，与主题同一套容错口径。
    LocaleController.instance.ensureInitialized();
  }

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<AppThemeMode>(
      valueListenable: ThemeController.instance,
      builder: (context, mode, _) => ValueListenableBuilder<AppLocale>(
        // 语言与主题各一个 ValueListenableBuilder：切语言只重建 locale，
        // 不与主题逻辑互相牵连（照抄桌面端「主题一套、语言一套、互不混用」的做法）
        valueListenable: LocaleController.instance,
        builder: (context, localePref, _) => MaterialApp(
          // 品牌名不写死：从生成的词条类取（en → Shanhai / zh → 山海）。
          // 注意 title 只在「无 BuildContext」的层级用得到，故走 brandTitleFor 而不是
          // AppLocalizations.of(context)（后者要等 MaterialApp 建好 Localizations 才有）。
          title: brandTitleFor(localePref),
          debugShowCheckedModeBanner: false,
          // —— i18n 挂载三件套（delegates / supportedLocales 直接用 gen_l10n 生成的那份，
          // 不在项目里另抄语言清单）——
          // locale 传 null = 跟随系统语言；非 null = 用户在 App 内显式选定，优先级最高。
          localizationsDelegates: AppLocalizations.localizationsDelegates,
          supportedLocales: AppLocalizations.supportedLocales,
          locale: localePref.toLocale,
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
      ),
    );
  }
}
