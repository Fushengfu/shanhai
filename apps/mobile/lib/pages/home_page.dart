import 'dart:async';
import 'package:flutter/material.dart';
import '../l10n/generated/app_localizations.dart';
import '../locale.dart';
import '../theme.dart';
import '../services/member_credentials.dart';
import '../services/token_store.dart';
import '../services/update_service.dart';
import '../services/ws_client.dart';
import '../widgets/device_picker.dart';
import '../widgets/update_dialog.dart';
import 'login_page.dart';
import 'session_list_page.dart';
import 'supervisor_page.dart';

/// 首页：底部导航切换「会话模式 / 管家模式」，顶部提供「切换设备」入口（同账号多电脑）。
///
/// 与旧版的关键差别（修复「电脑端不在线时手机端无路可走」）：
/// - 未配对到桌面端（Host 离线 / 连接断开）**不再阻塞进入首页**：首页用顶部横幅如实呈现状态，
///   并在横幅内常驻「重试 / 切换设备 / 退出登录」三个出口；
/// - 「切换设备」入口不再只依赖被动等网关下发 devices_list，点了没反馈也会明确提示。
class HomePage extends StatefulWidget {
  final WsClient ws;

  /// 从启动页带入的「目标桌面端离线」初值：host_offline 是一次性事件，
  /// 启动页消费掉后首页不会再收到，必须显式传入，否则横幅不会显示。
  final bool initialHostOffline;

  const HomePage({super.key, required this.ws, this.initialHostOffline = false});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  int _index = 0;
  bool _hostOffline = false;
  ConnState _conn = ConnState.disconnected;
  bool _switchingDevice = false;
  bool _checkingUpdate = false;
  bool _retrying = false;
  bool _awaitingDevices = false;
  StreamSubscription<ServerEvent>? _eventSub;
  StreamSubscription<ConnState>? _stateSub;
  StreamSubscription<CredentialSnapshot>? _credSub;
  Timer? _devicesTimeout;

  // —————————————————— 凭证三态（续签）——————————————————
  //
  // 复用同一个顶部横幅组件呈现，**不新增第五种状态**：
  //   anonymous  → 红色变体「登录已失效，请重新登录」（主出口=重新登录）
  //   expired    → 「登录凭证已过期，正在自动续签…」
  //   renewing   → 「登录凭证即将到期，已自动续签」（中性提示）
  //   unknown    → 中性提示「凭证有效期未知」
  CredentialSnapshot _cred = MemberCredentials.instance.snapshot;

  /// 续签定时器归属：本页 dispose 时只有 owner 匹配才停表（避免误停/漏停）
  static const _credOwner = 'home-page';

  /// 凭证是否已确认失效（本地无 token）：横幅要变成红色变体并给「重新登录」出口
  bool get _authInvalid => _cred.state == CredentialState.anonymous && _conn != ConnState.paired;

  /// 「必须占用横幅」的凭证态：anonymous（已失效，唯一出路是重登）与 expired
  /// （握手时会被拒，断线后必掉线，需要给用户「立即续签」的主动出口）。
  bool get _credMustShow =>
      _cred.state == CredentialState.anonymous || _cred.state == CredentialState.expired;

  /// 「只在横幅已展开时补一行」的凭证态：renewing / unknown。
  /// 刻意**不**为了它们单独弹出横幅——否则已正常连接的用户会被一条永久提示条长期占位，
  /// 变成新的骚扰；如实呈现的同时保持界面克制。
  bool get _credSoftNote =>
      _cred.state == CredentialState.renewing || _cred.state == CredentialState.unknown;

  /// 是否已配对到具体桌面端（未配对时展示顶部状态横幅）
  bool get _showBanner => _conn != ConnState.paired || _credMustShow;

  @override
  void initState() {
    super.initState();
    _conn = widget.ws.state;
    // 初始状态如实反映当前连接：paired 之外都算「未连上桌面端」。
    // 之前只靠 host_offline 事件点亮横幅，而该事件在启动页就被消费掉了，
    // 从启动页带着「离线」跳进来时横幅是空的，用户以为已经连上了。
    _hostOffline = widget.initialHostOffline || widget.ws.state != ConnState.paired;
    // 主页存续期间持有续签定时器（owner=home-page）：
    // 启动页交接过来时 owner 已被本页 start() 覆盖，启动页 dispose 的 stop 是空操作
    MemberCredentials.instance.start(_credOwner);
    _credSub = MemberCredentials.instance.status.listen((snap) {
      if (!mounted) return;
      setState(() => _cred = snap);
    });
    // 桌面端 Host 离线/上线提示 + 设备列表（切换设备用）+ 凭证事件
    _eventSub = widget.ws.events.listen((e) {
      if (!mounted) return;
      if (e.event == 'host_offline') {
        if (!_hostOffline) setState(() => _hostOffline = true);
      } else if (e.event == 'host_online') {
        if (_hostOffline) setState(() => _hostOffline = false);
      } else if (e.event == 'auth_renewed') {
        _snack((l) => l.homeSnackRenewed);
      } else if (e.event == 'auth_expired') {
        // 凭证确认不可恢复：横幅转红色变体并给「重新登录」出口（复用同一横幅，不新增状态）
        setState(() {
          _cred = MemberCredentials.instance.snapshot;
          _conn = widget.ws.state;
          _hostOffline = true;
        });
        // 服务端带回的 message 原样呈现（口径④：不建映射表）；只有它没带回时
        // 才用山海自己的兜底文案 —— 顺序与改前 ?? 完全一致
        final gwMsg = e.payload['message']?.toString();
        _snack(gwMsg == null ? (l) => l.commonLoginExpiredFallback : rawText(gwMsg));
      } else if (e.event == 'devices_list') {
        _awaitingDevices = false;
        _devicesTimeout?.cancel();
        _showDevicePicker(e.payload['devices'] as List? ?? const []);
      }
    });
    // 连接态变化：paired 清横幅；disconnected 亮横幅（自动重连中也要让用户看到状态）
    _stateSub = widget.ws.stateStream.listen((s) {
      if (!mounted) return;
      setState(() {
        _conn = s;
        if (s == ConnState.paired) _hostOffline = false;
        if (s == ConnState.disconnected) _hostOffline = true;
      });
    });
    // 进入主页后静默检查一次版本更新（有更新才弹窗，无更新不打扰）
    Future.microtask(() => _checkUpdate(silent: true));
  }

  /// 版本检查：silent=true 时无更新不提示；手动触发（按钮）时无论结果都给反馈。
  Future<void> _checkUpdate({bool silent = false}) async {
    if (_checkingUpdate) return;
    _checkingUpdate = true;
    final result = await UpdateService().check();
    _checkingUpdate = false;
    if (!mounted) return;

    if (result.hasUpdate && result.update != null) {
      await showUpdateDialog(context, result.update!);
    } else if (!silent) {
      final gwErr = result.error;
      final msg = gwErr ?? AppLocalizations.of(context).homeLatestVersion;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(msg, style: const TextStyle(fontSize: 13))),
      );
    }
  }

  /// 请求设备列表后弹出选择器，选中后切换连接目标设备。
  /// 与旧版差别：发不出去（未连上网关）时明确提示，不再「点了图标什么也没发生」；
  /// 并加等待兜底，网关不回 devices_list 时给提示而不是静默。
  void _requestSwitchDevice() {
    if (!_wsAlive) {
      _snack((l) => l.homeSnackWsDown);
      return;
    }
    if (!widget.ws.listDevices()) {
      _snack((l) => l.homeSnackNoGwList);
      return;
    }
    _awaitingDevices = true;
    _devicesTimeout?.cancel();
    _devicesTimeout = Timer(const Duration(seconds: 6), () {
      if (!mounted || !_awaitingDevices) return;
      _awaitingDevices = false;
      _snack((l) => l.homeSnackNoDeviceListYet);
    });
  }

  /// 连接是否还能发命令（未配对但已连上网关时也可查设备列表）
  bool get _wsAlive =>
      widget.ws.state == ConnState.connected || widget.ws.state == ConnState.paired;

  Future<void> _showDevicePicker(List<dynamic> devices) async {
    if (_switchingDevice) return;
    if (devices.isEmpty) {
      // 网关回了空列表：如实提示，不弹空白弹层
      _snack((l) => l.homeSnackNoOnlineDevice);
      return;
    }
    _switchingDevice = true;
    final chosen = await showDevicePickerSheet(context, devices);
    if (chosen != null && chosen.isNotEmpty) {
      // switchDevice 内部会取消排队中的自动重连与旧连接，避免旧回调把页面拽回加载态
      await widget.ws.switchDevice(chosen);
    }
    if (mounted) setState(() => _switchingDevice = false);
  }

  /// 重试当前设备：打断自动重连与旧连接，立即重新握手；配对成功后 stateStream 会自动清横幅
  Future<void> _retryConnect() async {
    if (_retrying) return;
    // 凭证已不可恢复（本地无 token）：重连没意义，直接引导重新登录，不给「点了没反应」的错觉
    if (!MemberCredentials.instance.isSignedIn) {
      _snack((l) => l.homeSnackCredInvalidRetry);
      await _logout(skipConfirm: true);
      return;
    }
    setState(() => _retrying = true);
    final ok = await widget.ws.reconnectNow();
    if (!mounted) return;
    setState(() {
      _retrying = false;
      _conn = widget.ws.state;
      _hostOffline = widget.ws.state != ConnState.paired;
      _cred = MemberCredentials.instance.snapshot;
    });
    _snack(ok ? (l) => l.homeSnackReconnected : (l) => l.homeSnackRetryFailed);
  }

  /// 凭证过期但仍在宽限期：手动触发一次续签 + 重连（横幅里的「立即续签」出口）
  Future<void> _renewNow() async {
    if (_retrying) return;
    setState(() => _retrying = true);
    final r = await widget.ws.renewAndReconnect();
    if (!mounted) return;
    setState(() {
      _retrying = false;
      _conn = widget.ws.state;
      _cred = MemberCredentials.instance.snapshot;
      _hostOffline = widget.ws.state != ConnState.paired;
    });
    switch (r.outcome) {
      case RefreshOutcome.rotated:
        _snack(r.connected ? (l) => l.homeSnackRenewOkConnected : (l) => l.homeSnackRenewOkBg);
        break;
      case RefreshOutcome.invalid:
        _snack((l) => l.homeSnackRenewInvalid);
        break;
      case RefreshOutcome.noToken:
        _snack((l) => l.homeSnackNoToken);
        break;
      case RefreshOutcome.transient:
        _snack((l) => l.homeSnackRenewTransient);
        break;
    }
  }

  /// 退出登录：清本地登录态并回登录页（换账号的出口，避免「连不上又退不出去」的死局）
  Future<void> _logout({bool skipConfirm = false}) async {
    if (!skipConfirm) {
      final yes = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: Text(AppLocalizations.of(context).commonLogout),
          content: Text(AppLocalizations.of(context).homeLogoutBody),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: Text(AppLocalizations.of(ctx).commonCancel)),
            TextButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: Text(AppLocalizations.of(ctx).homeLogoutConfirm, style: const TextStyle(color: Colors.redAccent)),
            ),
          ],
        ),
      );
      if (yes != true || !mounted) return;
    }
    // 先停续签定时器（owner=home-page），杜绝「登出后还在打网关续签」
    MemberCredentials.instance.onLoggedOut();
    try {
      await TokenStore.clear();
    } catch (_) {}
    final ws = widget.ws;
    _eventSub?.cancel();
    _stateSub?.cancel();
    _credSub?.cancel();
    _eventSub = null;
    _stateSub = null;
    _credSub = null;
    if (!mounted) return;
    Navigator.of(context).pushAndRemoveUntil(
      MaterialPageRoute(builder: (_) => const LoginPage()),
      (route) => false,
    );
    // 页面已切换，再释放旧连接（dispose 会关闭事件流，必须让本页先退订）
    unawaited(ws.dispose());
  }

  /// 提示条。参数是 L10nText（「怎么取词」）而不是已翻译好的 String ——
  /// 与 7A 的 startup_page 同一口径：在弹出的那一刻按当前语言求值，
  /// 切语言后新弹出的提示自然是新语言，也不会把译文存进任何长期状态。
  void _snack(L10nText text) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
      content: Text(text(AppLocalizations.of(context)), style: const TextStyle(fontSize: 13)),
      duration: const Duration(seconds: 3),
      ),
    );
  }

  /// 顶部状态横幅：未配对到桌面端 / 凭证需要关注时如实说明卡在哪一步，并**常驻出口按钮**
  /// （重试当前设备 / 切换其它设备 / 退出登录），杜绝「只能干等、没有任何按钮」的死局。
  ///
  /// 凭证三态复用同一个横幅组件（只换文案、配色与出口），**不新增第五种状态**。
  Widget _buildStatusBanner() {
  // 【谁取词谁订阅】本方法由 build 调用，这里取一次 of(context)：
  // 既登记语言依赖（语言变化 → Localizations 通知 → 本页重渲染），
  // 又让横幅文案在每次渲染时重新求值。
  final l = AppLocalizations.of(context);
    // —— 凭证失效变体（红色）：本地已无可用 token，重连必然被拒，唯一有效出口是重新登录 ——
    if (_authInvalid) {
      return Material(
        color: const Color(0xFF7F1D1D),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 10, 10, 10),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Icon(Icons.lock_outline, size: 16, color: Color(0xFFFCA5A5)),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      l.commonLoginExpiredFallback,
                      style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: Color(0xFFFEE2E2)),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 4),
              Padding(
                padding: const EdgeInsets.only(left: 24),
                child: Text(
                  l.homeBannerAuthInvalidDetail,
                  // 相邻拼接的第二行已并入词条（Dart 'a' 'b' 语法）
                  style: const TextStyle(fontSize: 11.5, height: 1.4, color: Color(0xFFFEE2E2)),
                ),
              ),
              const SizedBox(height: 6),
              Padding(
                padding: const EdgeInsets.only(left: 18),
                child: Wrap(
                  spacing: 6,
                  runSpacing: 2,
                  children: [
                    _bannerAction(Icons.replay, (x) => x.startupRelogin, false, () => _logout(skipConfirm: true)),
                    _bannerAction(Icons.refresh, (x) => x.homeBannerRetryRenew, _retrying, _renewNow,
                    busyLabel: (x) => x.homeBusyRetryRenew),
                    _bannerAction(Icons.logout, (x) => x.commonLogout, false, _logout),
                  ],
                ),
              ),
            ],
          ),
        ),
      );
    }

    // —— 凭证已过期（仍在自动续签中）：琥珀色 + 「立即续签」出口，连接仍可用 ——
    if (_credMustShow) {
      final expired = _cred.state == CredentialState.expired;
      return Material(
        color: const Color(0xFF7C4A12),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 10, 10, 10),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Icon(Icons.shield_outlined, size: 16, color: Color(0xFFFBBF24)),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      // 期7C：describe() 已改返回闭包（它被存进 state 字段，不能烘译文），
                      // 这里在渲染期求值 → 凭证三态与横幅其余文案同语言
                      expired ? l.homeBannerExpiredTitle : _cred.describe()(l),
                      style: const TextStyle(
                          fontSize: 13, fontWeight: FontWeight.w600, color: Color(0xFFFDE68A)),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 4),
              Padding(
                padding: const EdgeInsets.only(left: 24),
                child: Text(
                  expired
                      ? l.homeBannerExpiredDetail
                        // 相邻拼接的第二行已并入词条
                      : (_cred.state == CredentialState.unknown
                          ? l.homeBannerUnknownDetail
                            // 相邻拼接的第二行已并入词条
                          : l.homeBannerRenewingDetail),
                  style: const TextStyle(fontSize: 11.5, height: 1.4, color: Color(0xFFFDE68A)),
                ),
              ),
              const SizedBox(height: 6),
              Padding(
                padding: const EdgeInsets.only(left: 18),
                child: Wrap(
                  spacing: 6,
                  runSpacing: 2,
                  children: [
                    _bannerAction(Icons.refresh, (x) => x.homeBannerRenewNow, _retrying, _renewNow,
                    busyLabel: (x) => x.homeBusyRenewNow),
                    _bannerAction(Icons.logout, (x) => x.commonLogout, false, _logout),
                  ],
                ),
              ),
            ],
          ),
        ),
      );
    }

    final disconnected = _conn == ConnState.disconnected;
    final connecting = _conn == ConnState.connecting;
    final title = disconnected
        ? l.startupGwDisconnected
        : connecting
            ? l.startupConnectingGw
            : (_hostOffline
                ? l.homeBannerHostOfflineTitle
                : l.commonGwConnectedWaitingHost);
    final detail = disconnected
        ? l.homeBannerDisconnectedDetail
        : connecting
            ? l.homeBannerConnectingDetail
            : l.homeBannerHostOfflineDetail
                // 相邻拼接的第二行已并入词条
;
    return Material(
      color: const Color(0xFF7C4A12),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 10, 10, 10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Icon(Icons.cloud_off_outlined, size: 16, color: Color(0xFFFBBF24)),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    title,
                    style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: Color(0xFFFDE68A)),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 4),
            Padding(
              padding: const EdgeInsets.only(left: 24),
              child: Text(detail, style: const TextStyle(fontSize: 11.5, height: 1.4, color: Color(0xFFFDE68A))),
            ),
            // 凭证「即将到期 / 有效期未知」：只在横幅已展开时补一行如实说明，不单独弹横幅
            if (_credSoftNote)
              Padding(
                padding: const EdgeInsets.only(left: 24, top: 2),
                child: Text(
                  _cred.describe()(l),
                  style: const TextStyle(fontSize: 11, height: 1.4, color: Color(0xFFFDE68A)),
                ),
              ),
            const SizedBox(height: 6),
            Padding(
              padding: const EdgeInsets.only(left: 18),
              child: Wrap(
                spacing: 6,
                runSpacing: 2,
                children: [
                  _bannerAction(Icons.refresh, (x) => x.homeActionRetry, _retrying, _retryConnect,
                  busyLabel: (x) => x.homeBusyRetry),
                  _bannerAction(
                  Icons.devices_other_outlined,
                  (x) => x.homeSwitchDeviceTooltip,
                  _switchingDevice,
                  _requestSwitchDevice,
                  busyLabel: (x) => x.homeBusySwitchDevice),
                  _bannerAction(Icons.logout, (x) => x.commonLogout, false, _logout),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// 横幅里的出口按钮。原来 busy 时是 `'$label…'` 拼出来的 —— 英文会拼成
  /// `Retry…`，与真正的进行时态（Retrying…）不是一回事，故改成独立词条。
  /// busyLabel 缺省时退回「原词 + 省略号」，保证不出现静默无反馈。
  Widget _bannerAction(IconData icon, L10nText label, bool busy, VoidCallback onTap,
  {L10nText? busyLabel}) {
  final l = AppLocalizations.of(context);
    return TextButton.icon(
      onPressed: busy ? null : onTap,
      icon: Icon(icon, size: 15, color: const Color(0xFFFDE68A)),
      label: Text(
      busy
      ? (busyLabel != null ? busyLabel(l) : '${label(l)}…')
      : label(l),
      style: const TextStyle(fontSize: 12, color: Color(0xFFFDE68A)),
      ),
      style: TextButton.styleFrom(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
        minimumSize: const Size(0, 30),
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        foregroundColor: const Color(0xFFFDE68A),
      ),
    );
  }

  @override
  void dispose() {
    _eventSub?.cancel();
    _stateSub?.cancel();
    _credSub?.cancel();
    _devicesTimeout?.cancel();
    // 本页销毁时取消自己持有的续签定时器（登出路径已在 _logout 里 forceStop，这里是防「页面被 pop 掉但没登出」的泄漏）
    MemberCredentials.instance.stop(_credOwner);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(AppLocalizations.of(context).brandShanhai,
        style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
        actions: [
          IconButton(
            tooltip: AppLocalizations.of(context).homeCheckUpdate,
            icon: const Icon(Icons.system_update_alt),
            onPressed: () => _checkUpdate(silent: false),
          ),
          // —— 语言切换入口（i18n 期7A）：与下面的主题入口并排、同一套范式 ——
          // 只有这一个新增控件走 l10n 取词；本文件其余文案属 7B，不在试点范围。
          ValueListenableBuilder<AppLocale>(
            valueListenable: LocaleController.instance,
            builder: (context, pref, _) => PopupMenuButton<AppLocale>(
              tooltip: AppLocalizations.of(context).localeMenuTooltip,
              icon: const Icon(Icons.language_outlined),
              onSelected: (v) => LocaleController.instance.setLocale(v),
              itemBuilder: (_) => [
                for (final v in AppLocale.values)
                  PopupMenuItem(
                    value: v,
                    child: Row(
                      children: [
                        Icon(v.icon, size: 18),
                        const SizedBox(width: 10),
                        // 在弹层构建期才取词 → 切语言后下次打开就是新语言
                        Text(v.label(AppLocalizations.of(context)),
                            style: const TextStyle(fontSize: 14)),
                        if (v == pref) ...[
                          const SizedBox(width: 8),
                          const Icon(Icons.check, size: 16, color: Color(0xFF8B5CF6)),
                        ],
                      ],
                    ),
                  ),
              ],
            ),
          ),
          // 主题切换入口：跟随系统 / 亮色 / 暗色（与桌面端主题机制对齐）
          ValueListenableBuilder<AppThemeMode>(
            valueListenable: ThemeController.instance,
            builder: (context, mode, _) => PopupMenuButton<AppThemeMode>(
              tooltip: AppLocalizations.of(context).homeThemeMenuTooltip,
              icon: Icon(mode.icon),
              onSelected: (m) => ThemeController.instance.setMode(m),
              itemBuilder: (_) => [
                for (final m in AppThemeMode.values)
                  PopupMenuItem(
                    value: m,
                    child: Row(
                      children: [
                        Icon(m.icon, size: 18),
                        const SizedBox(width: 10),
                        Text(m.label(AppLocalizations.of(context)),
                        style: const TextStyle(fontSize: 14)),
                        if (m == mode) ...[
                          const SizedBox(width: 8),
                          const Icon(Icons.check, size: 16, color: Color(0xFF8B5CF6)),
                        ],
                      ],
                    ),
                  ),
              ],
            ),
          ),
          IconButton(
            tooltip: AppLocalizations.of(context).homeSwitchDeviceTooltip,
            icon: const Icon(Icons.devices_outlined),
            onPressed: _requestSwitchDevice,
          ),
          // 退出登录入口：原先主页没有任何登出出口，一旦连不上电脑又退不出去就成了死局
          IconButton(
            tooltip: AppLocalizations.of(context).commonLogout,
            icon: const Icon(Icons.logout_outlined),
            onPressed: _logout,
          ),
        ],
      ),
      body: Column(
        children: [
          if (_showBanner) _buildStatusBanner(),
          Expanded(
            child: IndexedStack(
              index: _index,
              children: [
                SessionListPage(ws: widget.ws),
                SupervisorPage(ws: widget.ws),
              ],
            ),
          ),
        ],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (i) => setState(() => _index = i),
        destinations: [
          NavigationDestination(
          icon: const Icon(Icons.forum_outlined),
          selectedIcon: const Icon(Icons.forum),
          label: AppLocalizations.of(context).homeNavSessions),
          NavigationDestination(
          icon: const Icon(Icons.supervisor_account_outlined),
          selectedIcon: const Icon(Icons.supervisor_account),
          label: AppLocalizations.of(context).homeNavSupervisor),
        ],
      ),
    );
  }
}
