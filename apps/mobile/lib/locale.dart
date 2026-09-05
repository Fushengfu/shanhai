import 'dart:ui' show PlatformDispatcher;

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'l10n/generated/app_localizations.dart';

/// 山海手机端语言支持（i18n 期7A 底座）。
///
/// 一比一照抄本仓库既有的主题范式（[theme.dart] 的 `AppThemeMode` + `ThemeStore` +
/// `ThemeController`），不引入任何第三方 i18n 框架 —— 与桌面端「照抄既有主题范式，
/// 不发明第二套」是同一条纪律。
///
/// 【与桌面端解耦，这是刻意的】手机端语言跟随**手机自己的系统语言 / 手机端自己的设置**，
/// 与桌面端设置毫无关系：桌面端切英文不应该让手机端变英文。期6 已查明
/// `remote-server.ts` / `remote-protocol.ts` 有 7 条「桌面端产出、显示在手机屏幕上」的
/// 错误文案，若让手机端跟着桌面端走，就会出现「手机系统是中文、因为连了一台英文桌面
/// 而看到英文错误」这种错配。正确修法是协议改传 code、由手机端按自己语言取词（后续独立
/// 一轮），本轮手机端一律只看自己。
///
/// 【词条只有一处真相】所有展示文案都来自 lib/l10n/*.arb（gen_l10n 生成
/// [AppLocalizations]）。本文件**不写死任何中文界面文案** —— 历轮已 9 次实证
/// 「模块级常量里存中文会在加载期固化，切语言不变」，这里连常量表都不放文案。

/// 语言偏好：跟随系统 / 简体中文 / English
enum AppLocale { system, zh, en }

/// 一条「待渲染的文案」：拿到当前语言的 [AppLocalizations] 才求值。
///
/// 为什么要有这个 typedef：手机端这些页面的状态文案是**存在 state 里**的
/// （`String _status`、`_failTitle`、`_failDetail`），如果直接存已翻译好的字符串，
/// 用户切语言后 state 里仍是旧语言那份 —— 正是桌面端历轮反复踩的
/// 「文案被烘进 useMemo/useState 缓存」坑（期4C 的 D1 就是它）。
/// 存「怎么取词」而不是存「取到的词」，切语言即时生效，且不需要在切语言时回写 state。
typedef L10nText = String Function(AppLocalizations l);

/// 一条「服务端原文」的包装：payload 里带回来的 message **原样呈现**（口径④：
/// 网关/桌面端返回的原文不在客户端建映射表），与山海自己写的文案区分开。
L10nText rawText(String text) => (l) => text;

extension AppLocaleX on AppLocale {
  /// 映射到 Material 的 Locale；`system` 返回 null 表示交给 Flutter 按平台语言解析
  Locale? get toLocale => switch (this) {
        AppLocale.system => null,
        AppLocale.zh => const Locale('zh'),
        AppLocale.en => const Locale('en'),
      };

  /// 持久化用字符串值
  String get storageValue => switch (this) {
        AppLocale.system => 'system',
        AppLocale.zh => 'zh',
        AppLocale.en => 'en',
      };

  /// 展示图标
  IconData get icon => switch (this) {
        AppLocale.system => Icons.language_outlined,
        AppLocale.zh => Icons.translate_outlined,
        AppLocale.en => Icons.translate_outlined,
      };

  /// 展示文案 —— 返回「怎么取词」，不在这里写死中文（自称名口径见 app_zh.arb：
  /// 语言自称名一律用本语言书写，英文界面里也显示「简体中文」）
  L10nText get label => switch (this) {
        AppLocale.system => (l) => l.localeFollowSystem,
        AppLocale.zh => (l) => l.localeZh,
        AppLocale.en => (l) => l.localeEn,
      };

  static AppLocale fromStorage(String? v) => switch (v) {
        'zh' => AppLocale.zh,
        'en' => AppLocale.en,
        _ => AppLocale.system,
      };
}

/// 把偏好解析成实际生效的 Locale（`system` 时读平台语言，非中文一律按英文处理，
/// 与 l10n.yaml 的 `fallback-locale: zh` 一致地只在「zh / en」两个候选里选）
Locale resolvedLocale(AppLocale pref) {
  if (pref != AppLocale.system) return pref.toLocale!;
  final code = PlatformDispatcher.instance.locale.languageCode.toLowerCase();
  return code == 'en' ? const Locale('en') : const Locale('zh');
}

/// 无 BuildContext 时（`MaterialApp.title`）按当前偏好取品牌名。
/// 走 gen_l10n 自己生成的 lookupAppLocalizations（与 MaterialApp 内部加载词条同一条路径），
/// 仍然只有一份词条真相，不在这里写死任何品牌字符串。
String brandTitleFor(AppLocale pref) =>
    lookupAppLocalizations(resolvedLocale(pref)).brandShanhai;

/// 语言偏好持久化（复用 flutter_secure_storage，与主题同一套存储；
/// 读失败/写失败都静默回退 system —— 语言坏了不该让人打不开 App）
class LocaleStore {
  static const _storage = FlutterSecureStorage(
    aOptions: AndroidOptions(resetOnError: true),
  );
  static const _kLocale = 'app_locale';

  static Future<AppLocale> read() async {
    try {
      return AppLocaleX.fromStorage(await _storage.read(key: _kLocale));
    } catch (_) {
      return AppLocale.system;
    }
  }

  static Future<void> save(AppLocale locale) async {
    try {
      await _storage.write(key: _kLocale, value: locale.storageValue);
    } catch (_) {
      // 写失败静默（不影响本次切换，下次启动回退跟随系统）
    }
  }
}

/// 全局语言控制器（一个 ValueNotifier，切换即持久化）。
/// MaterialApp 用 ValueListenableBuilder 监听它驱动 locale。
class LocaleController extends ValueNotifier<AppLocale> {
  LocaleController._() : super(AppLocale.system);
  static final LocaleController instance = LocaleController._();

  bool _initialized = false;

  /// 启动时读取持久化偏好（幂等，多次调用只读一次）
  Future<void> ensureInitialized() async {
    if (_initialized) return;
    _initialized = true;
    value = await LocaleStore.read();
  }

  /// 切换语言（同时持久化）
  Future<void> setLocale(AppLocale locale) async {
    if (value == locale) return;
    value = locale;
    await LocaleStore.save(locale);
  }
}

// 说明：MaterialApp 需要的 localizationsDelegates / supportedLocales 直接用
// gen_l10n 生成的 AppLocalizations.localizationsDelegates / .supportedLocales，
// 不在本文件另抄一份清单 —— 另抄就是第二套真相（语言集合要改两处）。
