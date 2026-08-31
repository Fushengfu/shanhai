import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// 山海手机端主题支持：
/// - 跟随系统（ThemeMode.system，默认）/ 亮色 / 暗色 三种模式；
/// - 偏好持久化（flutter_secure_storage，与桌面端 localStorage 的 shanhai-theme 对应）；
/// - 语义色通过 ThemeExtension`AppColors` 提供，组件用 context.appColors 取色，
///   主题切换时依赖 Theme 的组件自动重建刷新（与桌面端 theme.css 的 data-theme 行为一致）。

/// 主题模式：跟随系统 / 亮色 / 暗色
enum AppThemeMode { system, light, dark }

extension AppThemeModeX on AppThemeMode {
  /// 映射到 Material 的 ThemeMode
  ThemeMode get toThemeMode => switch (this) {
        AppThemeMode.system => ThemeMode.system,
        AppThemeMode.light => ThemeMode.light,
        AppThemeMode.dark => ThemeMode.dark,
      };

  /// 持久化用字符串值
  String get storageValue => switch (this) {
        AppThemeMode.system => 'system',
        AppThemeMode.light => 'light',
        AppThemeMode.dark => 'dark',
      };

  /// 展示文案（切换入口菜单用）
  String get label => switch (this) {
        AppThemeMode.system => '跟随系统',
        AppThemeMode.light => '亮色',
        AppThemeMode.dark => '暗色',
      };

  /// 展示图标
  IconData get icon => switch (this) {
        AppThemeMode.system => Icons.brightness_auto,
        AppThemeMode.light => Icons.light_mode_outlined,
        AppThemeMode.dark => Icons.dark_mode_outlined,
      };

  static AppThemeMode fromStorage(String? v) => switch (v) {
        'light' => AppThemeMode.light,
        'dark' => AppThemeMode.dark,
        _ => AppThemeMode.system,
      };
}

/// 主题偏好持久化（复用 flutter_secure_storage；读失败/写失败都静默回退 system）
class ThemeStore {
  static const _storage = FlutterSecureStorage(
    aOptions: AndroidOptions(resetOnError: true),
  );
  static const _kTheme = 'app_theme';

  static Future<AppThemeMode> read() async {
    try {
      return AppThemeModeX.fromStorage(await _storage.read(key: _kTheme));
    } catch (_) {
      return AppThemeMode.system;
    }
  }

  static Future<void> save(AppThemeMode mode) async {
    try {
      await _storage.write(key: _kTheme, value: mode.storageValue);
    } catch (_) {
      // 写失败静默（不影响本次切换，下次启动回退）
    }
  }
}

/// 全局主题控制器：ValueListenable`AppThemeMode`，切换即持久化。
/// MaterialApp 用 ValueListenableBuilder 监听它驱动 themeMode。
class ThemeController extends ValueNotifier<AppThemeMode> {
  ThemeController._() : super(AppThemeMode.system);
  static final ThemeController instance = ThemeController._();

  bool _initialized = false;

  /// 启动时读取持久化偏好（幂等，多次调用只读一次）
  Future<void> ensureInitialized() async {
    if (_initialized) return;
    _initialized = true;
    value = await ThemeStore.read();
  }

  /// 切换主题模式（同时持久化）
  Future<void> setMode(AppThemeMode mode) async {
    if (value == mode) return;
    value = mode;
    await ThemeStore.save(mode);
  }
}

/// 语义色（对齐桌面端 theme.css 的 light/dark 两套变量 + 手机端既有暗色值）。
/// 组件统一用 context.appColors 取色，禁止再写死 0xFF 常量。
@immutable
class AppColors extends ThemeExtension<AppColors> {
  // —— 背景层级 ——
  final Color scaffoldBg; // 页面底色
  final Color surfaceBg; // AppBar / 导航栏 / 弹窗壳
  final Color cardBg; // 卡片 / 助手气泡 / 输入框
  final Color inputBg; // 弹窗内输入框填充
  final Color bottomSheetBg; // 底部菜单 / 弹窗
  final Color border; // 分隔线 / 折叠竖线
  // —— 文字 ——
  final Color textPrimary; // 主文字
  final Color textSecondary; // 次级文字（reasoning 内容）
  final Color textMuted; // 弱文字（摘要/元信息）
  final Color textFaint; // 最弱文字（行号/折叠提示）
  final Color textOnAccent; // 强调底色上的文字（用户气泡白字）
  // —— 气泡 ——
  final Color bubbleUser; // 用户气泡（主题紫）
  final Color bubbleAi; // 助手气泡背景
  // —— 代码 / 终端 ——
  final Color codeBg; // 代码块 / 纯文本块背景
  final Color codeText; // 代码文字（行内 code）
  final Color terminalBg; // 终端命令行背景
  final Color terminalOut; // 终端输出背景
  final Color terminalCmd; // 终端命令文字
  final Color terminalPrompt; // 终端 $ 提示符
  // —— diff ——
  final Color diffAddBg;
  final Color diffDelBg;
  final Color diffFoldBg;
  // —— 状态色 ——
  final Color running; // 执行中（青）
  final Color success; // 成功（绿）
  final Color error; // 失败（红）
  final Color pending; // 待确认（琥珀）
  final Color approvalTagBg; // 待确认标签底
  // —— 风险等级 ——
  final Color riskHigh;
  final Color riskWarn;
  final Color riskOk;
  final Color riskGray;

  const AppColors({
    required this.scaffoldBg,
    required this.surfaceBg,
    required this.cardBg,
    required this.inputBg,
    required this.bottomSheetBg,
    required this.border,
    required this.textPrimary,
    required this.textSecondary,
    required this.textMuted,
    required this.textFaint,
    required this.textOnAccent,
    required this.bubbleUser,
    required this.bubbleAi,
    required this.codeBg,
    required this.codeText,
    required this.terminalBg,
    required this.terminalOut,
    required this.terminalCmd,
    required this.terminalPrompt,
    required this.diffAddBg,
    required this.diffDelBg,
    required this.diffFoldBg,
    required this.running,
    required this.success,
    required this.error,
    required this.pending,
    required this.approvalTagBg,
    required this.riskHigh,
    required this.riskWarn,
    required this.riskOk,
    required this.riskGray,
  });

  /// 暗色（与手机端既有暗色值完全一致，默认主题）
  static const dark = AppColors(
    scaffoldBg: Color(0xFF0E0E14),
    surfaceBg: Color(0xFF16161F),
    cardBg: Color(0xFF1A1A24),
    inputBg: Color(0xFF262633),
    bottomSheetBg: Color(0xFF1C1C26),
    border: Color(0xFF3A3A3C),
    textPrimary: Color(0xFFE0E0E0),
    textSecondary: Color(0xFFB0B0B8),
    textMuted: Color(0xFF808080),
    textFaint: Color(0xFF5A5A5A),
    textOnAccent: Colors.white,
    bubbleUser: Color(0xFF8B5CF6),
    bubbleAi: Color(0xFF1A1A24),
    codeBg: Color(0xFF14141C),
    codeText: Color(0xFF7DD3FC),
    terminalBg: Color(0xFF282C34),
    terminalOut: Color(0xFF1E1E1E),
    terminalCmd: Color(0xFF61AFEF),
    terminalPrompt: Color(0xFF7F848E),
    diffAddBg: Color(0xFF1F2E1F),
    diffDelBg: Color(0xFF332022),
    diffFoldBg: Color(0xFF232325),
    running: Color(0xFF22D3EE),
    success: Color(0xFF34D399),
    error: Color(0xFFF87171),
    pending: Color(0xFFF59E0B),
    approvalTagBg: Color(0xFF332B1A),
    riskHigh: Color(0xFFEF4444),
    riskWarn: Color(0xFFF59E0B),
    riskOk: Color(0xFF34D399),
    riskGray: Color(0xFF9CA3AF),
  );

  /// 亮色（浅色系；代码/终端块保持深色终端样式，与桌面端一致）
  static const light = AppColors(
    scaffoldBg: Color(0xFFF4F4F7),
    surfaceBg: Color(0xFFFFFFFF),
    cardBg: Color(0xFFFFFFFF),
    inputBg: Color(0xFFEDEDF2),
    bottomSheetBg: Color(0xFFFFFFFF),
    border: Color(0xFFE2E2E8),
    textPrimary: Color(0xFF1A1A22),
    textSecondary: Color(0xFF55555F),
    textMuted: Color(0xFF8A8A94),
    textFaint: Color(0xFFA0A0AA),
    textOnAccent: Colors.white,
    bubbleUser: Color(0xFF8B5CF6),
    bubbleAi: Color(0xFFF0F0F5),
    codeBg: Color(0xFFF2F2F6),
    codeText: Color(0xFF7C3AED),
    terminalBg: Color(0xFF282C34),
    terminalOut: Color(0xFF1E1E1E),
    terminalCmd: Color(0xFF61AFEF),
    terminalPrompt: Color(0xFF7F848E),
    diffAddBg: Color(0xFFE9F7EE),
    diffDelBg: Color(0xFFFBE9EC),
    diffFoldBg: Color(0xFFF0F0F3),
    running: Color(0xFF0891B2),
    success: Color(0xFF059669),
    error: Color(0xFFDC2626),
    pending: Color(0xFFD97706),
    approvalTagBg: Color(0xFFFEF3C7),
    riskHigh: Color(0xFFDC2626),
    riskWarn: Color(0xFFD97706),
    riskOk: Color(0xFF059669),
    riskGray: Color(0xFF6B7280),
  );

  @override
  AppColors copyWith({
    Color? scaffoldBg,
    Color? surfaceBg,
    Color? cardBg,
    Color? inputBg,
    Color? bottomSheetBg,
    Color? border,
    Color? textPrimary,
    Color? textSecondary,
    Color? textMuted,
    Color? textFaint,
    Color? textOnAccent,
    Color? bubbleUser,
    Color? bubbleAi,
    Color? codeBg,
    Color? codeText,
    Color? terminalBg,
    Color? terminalOut,
    Color? terminalCmd,
    Color? terminalPrompt,
    Color? diffAddBg,
    Color? diffDelBg,
    Color? diffFoldBg,
    Color? running,
    Color? success,
    Color? error,
    Color? pending,
    Color? approvalTagBg,
    Color? riskHigh,
    Color? riskWarn,
    Color? riskOk,
    Color? riskGray,
  }) {
    return AppColors(
      scaffoldBg: scaffoldBg ?? this.scaffoldBg,
      surfaceBg: surfaceBg ?? this.surfaceBg,
      cardBg: cardBg ?? this.cardBg,
      inputBg: inputBg ?? this.inputBg,
      bottomSheetBg: bottomSheetBg ?? this.bottomSheetBg,
      border: border ?? this.border,
      textPrimary: textPrimary ?? this.textPrimary,
      textSecondary: textSecondary ?? this.textSecondary,
      textMuted: textMuted ?? this.textMuted,
      textFaint: textFaint ?? this.textFaint,
      textOnAccent: textOnAccent ?? this.textOnAccent,
      bubbleUser: bubbleUser ?? this.bubbleUser,
      bubbleAi: bubbleAi ?? this.bubbleAi,
      codeBg: codeBg ?? this.codeBg,
      codeText: codeText ?? this.codeText,
      terminalBg: terminalBg ?? this.terminalBg,
      terminalOut: terminalOut ?? this.terminalOut,
      terminalCmd: terminalCmd ?? this.terminalCmd,
      terminalPrompt: terminalPrompt ?? this.terminalPrompt,
      diffAddBg: diffAddBg ?? this.diffAddBg,
      diffDelBg: diffDelBg ?? this.diffDelBg,
      diffFoldBg: diffFoldBg ?? this.diffFoldBg,
      running: running ?? this.running,
      success: success ?? this.success,
      error: error ?? this.error,
      pending: pending ?? this.pending,
      approvalTagBg: approvalTagBg ?? this.approvalTagBg,
      riskHigh: riskHigh ?? this.riskHigh,
      riskWarn: riskWarn ?? this.riskWarn,
      riskOk: riskOk ?? this.riskOk,
      riskGray: riskGray ?? this.riskGray,
    );
  }

  @override
  AppColors lerp(ThemeExtension<AppColors>? other, double t) {
    if (other is! AppColors) return this;
    return AppColors(
      scaffoldBg: Color.lerp(scaffoldBg, other.scaffoldBg, t)!,
      surfaceBg: Color.lerp(surfaceBg, other.surfaceBg, t)!,
      cardBg: Color.lerp(cardBg, other.cardBg, t)!,
      inputBg: Color.lerp(inputBg, other.inputBg, t)!,
      bottomSheetBg: Color.lerp(bottomSheetBg, other.bottomSheetBg, t)!,
      border: Color.lerp(border, other.border, t)!,
      textPrimary: Color.lerp(textPrimary, other.textPrimary, t)!,
      textSecondary: Color.lerp(textSecondary, other.textSecondary, t)!,
      textMuted: Color.lerp(textMuted, other.textMuted, t)!,
      textFaint: Color.lerp(textFaint, other.textFaint, t)!,
      textOnAccent: Color.lerp(textOnAccent, other.textOnAccent, t)!,
      bubbleUser: Color.lerp(bubbleUser, other.bubbleUser, t)!,
      bubbleAi: Color.lerp(bubbleAi, other.bubbleAi, t)!,
      codeBg: Color.lerp(codeBg, other.codeBg, t)!,
      codeText: Color.lerp(codeText, other.codeText, t)!,
      terminalBg: Color.lerp(terminalBg, other.terminalBg, t)!,
      terminalOut: Color.lerp(terminalOut, other.terminalOut, t)!,
      terminalCmd: Color.lerp(terminalCmd, other.terminalCmd, t)!,
      terminalPrompt: Color.lerp(terminalPrompt, other.terminalPrompt, t)!,
      diffAddBg: Color.lerp(diffAddBg, other.diffAddBg, t)!,
      diffDelBg: Color.lerp(diffDelBg, other.diffDelBg, t)!,
      diffFoldBg: Color.lerp(diffFoldBg, other.diffFoldBg, t)!,
      running: Color.lerp(running, other.running, t)!,
      success: Color.lerp(success, other.success, t)!,
      error: Color.lerp(error, other.error, t)!,
      pending: Color.lerp(pending, other.pending, t)!,
      approvalTagBg: Color.lerp(approvalTagBg, other.approvalTagBg, t)!,
      riskHigh: Color.lerp(riskHigh, other.riskHigh, t)!,
      riskWarn: Color.lerp(riskWarn, other.riskWarn, t)!,
      riskOk: Color.lerp(riskOk, other.riskOk, t)!,
      riskGray: Color.lerp(riskGray, other.riskGray, t)!,
    );
  }
}

/// 便捷取色：Theme.of(context).extension`AppColors`()，缺省回退暗色（与旧行为一致）
extension AppColorsX on BuildContext {
  AppColors get appColors => Theme.of(this).extension<AppColors>() ?? AppColors.dark;
}

/// 亮/暗两套 ThemeData（语义色统一走 AppColors extension）
class AppTheme {
  static final light = ThemeData(
    brightness: Brightness.light,
    scaffoldBackgroundColor: AppColors.light.scaffoldBg,
    colorScheme: const ColorScheme.light(
      primary: Color(0xFF8B5CF6),
      secondary: Color(0xFF0891B2),
      surface: Color(0xFFFFFFFF),
    ),
    useMaterial3: true,
    appBarTheme: AppBarTheme(
      backgroundColor: Colors.transparent,
      foregroundColor: AppColors.light.textPrimary,
      elevation: 0,
    ),
    listTileTheme: ListTileThemeData(
      dense: true,
      visualDensity: VisualDensity.compact,
      titleTextStyle: TextStyle(fontSize: 14, color: AppColors.light.textPrimary),
      subtitleTextStyle: TextStyle(fontSize: 12, color: AppColors.light.textMuted),
    ),
    checkboxTheme: const CheckboxThemeData(visualDensity: VisualDensity.compact),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: AppColors.light.surfaceBg,
      indicatorColor: const Color(0xFFE5E5EC),
    ),
    extensions: const [AppColors.light],
  );

  static final dark = ThemeData(
    brightness: Brightness.dark,
    scaffoldBackgroundColor: AppColors.dark.scaffoldBg,
    colorScheme: const ColorScheme.dark(
      primary: Color(0xFF8B5CF6),
      secondary: Color(0xFF22D3EE),
      surface: Color(0xFF16161F),
    ),
    useMaterial3: true,
    appBarTheme: AppBarTheme(
      backgroundColor: Colors.transparent,
      foregroundColor: AppColors.dark.textPrimary,
      elevation: 0,
    ),
    listTileTheme: const ListTileThemeData(
      dense: true,
      visualDensity: VisualDensity.compact,
      titleTextStyle: TextStyle(fontSize: 14, color: Color(0xFFE0E0E0)),
      subtitleTextStyle: TextStyle(fontSize: 12, color: Color(0xFF808080)),
    ),
    checkboxTheme: const CheckboxThemeData(visualDensity: VisualDensity.compact),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: AppColors.dark.surfaceBg,
      indicatorColor: const Color(0xFF2A2A3A),
    ),
    extensions: const [AppColors.dark],
  );
}
