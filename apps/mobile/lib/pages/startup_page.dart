import 'dart:async';
import 'package:flutter/material.dart';
import '../l10n/generated/app_localizations.dart';
import '../locale.dart';
import '../theme.dart';
import '../services/member_credentials.dart';
import '../services/token_store.dart';
import '../services/ws_client.dart';
import '../widgets/device_picker.dart';
import 'home_page.dart';
import 'login_page.dart';

/// 主动请求设备列表后，等待网关下发 devices_list 的兜底时长（超时给提示，不静默）
const Duration kStartupDevicesWait = Duration(seconds: 6);

/// 启动页阶段：转圈恢复中 / 失败态（有明确出口按钮）
enum _StartupPhase { restoring, failed }

/// 启动分流页：读本地缓存 token——有则连网关尝试自动恢复，无则进登录页。
///
/// 本版本重点修复「已登录但电脑端不在线 → 一直卡在恢复连接加载页、既进不去程序也切不了设备」：
/// 1. **超时兜底**：恢复等待有 12s 上限，超时即转失败态，不再无限转圈；
/// 2. **解耦登录态与连接态**：token 有效且已连上网关（哪怕目标电脑离线）就直接进主界面，
///    由主页的离线横幅承接「未连上某台电脑」这个可选状态，不再把 paired 当进入前置条件；
/// 3. **出口常驻**：等待态与失败态都提供「重试 / 切换设备 / 进入主界面 / 退出登录」，杜绝死局；
/// 4. **可打断重连**：用户主动重试/切设备时取消排队中的自动重连与旧连接，避免旧回调把页面拽回加载态。
class StartupPage extends StatefulWidget {
  const StartupPage({super.key});

  @override
  State<StartupPage> createState() => _StartupPageState();
}

class _StartupPageState extends State<StartupPage> {
  final _ws = WsClient();
  _StartupPhase _phase = _StartupPhase.restoring;

  /// 【为什么是 L10nText 而不是 String】这三个字段都是 state。
  /// 直接存「已翻译好的字符串」= 把语言烘进 state：用户中途切语言，这里仍是旧语言，
  /// 正是桌面端历轮反复踩的同一个坑（期4C 的 banner useMemo D1 就是它）。
  /// 存「怎么取词」、在 build 里才求值，切语言即时生效，且不需要在切语言时回写 state。
  L10nText _status = (l) => l.startupRestoring;
  L10nText _failTitle = (l) => l.startupFailTitleDefault;
  L10nText _failDetail = (l) => '';

  /// 是否已经连上网关（区分「压根连不上网关」与「网关正常、只是电脑不在线」两种如实文案）
  bool _gatewayReached = false;

  /// 设备选择弹层是否打开中（打开期间不做跳转，避免弹层随路由被销毁）
  bool _pendingDeviceChoice = false;

  /// 重试 / 切设备等主动操作进行中（禁用按钮防重复点）
  bool _busy = false;

  /// 已发起跳转：之后所有连接回调一律忽略，避免旧回调把新页面又拽回加载态
  bool _navigated = false;

  /// 是否正在等网关回 devices_list
  bool _awaitingDevices = false;

  /// 凭证已确认失效（refresh 也救不回来）：失败态的主出口改为「重新登录」。
  /// 注意这**不是新的页面阶段**，只是同一个 failed 阶段下的文案/主按钮差异，
  /// 避免与上一轮「失败态四出口」叠出第五个互相矛盾的状态。
  bool _authExpired = false;

  /// 凭证状态提示（三态如实呈现）
  // 存「怎么取词」而不是「取到的词」（同 login_page，期7C）
  L10nText? _credHint;

  /// 续签定时器归属标记（owner 不匹配时 stop 是空操作，不会误停主页的定时器）
  static const _credOwner = 'startup-page';

  Timer? _pairTimeout;
  Timer? _devicesTimeout;
  StreamSubscription<ConnState>? _stateSub;
  StreamSubscription<ServerEvent>? _eventSub;
  StreamSubscription<CredentialSnapshot>? _credSub;

  @override
  void initState() {
    super.initState();
    _credSub = MemberCredentials.instance.status.listen((snap) {
      if (!mounted || _navigated) return;
      setState(() => _credHint = snap.state == CredentialState.anonymous ? null : snap.describe());
    });
    _stateSub = _ws.stateStream.listen((s) {
      if (_navigated || !mounted) return;
      switch (s) {
        case ConnState.paired:
          // 已配对到具体 Host：清掉超时，直接进主页
          _pairTimeout?.cancel();
          _goHome();
          break;
        case ConnState.connected:
          // 连上了网关但尚未配对：可能处于「Host 离线」或「多设备待选」，
          // 这里只更新文案，跳转交给 host_offline / devices_list / 超时三条明确路径处理。
          _gatewayReached = true;
          setState(() => _status = (l) => l.commonGwConnectedWaitingHost);
          break;
        case ConnState.connecting:
          if (mounted) setState(() => _status = (l) => l.startupConnectingGw);
          break;
        case ConnState.disconnected:
          if (mounted) {
            setState(() => _status =
                _gatewayReached ? (l) => l.startupGwDisconnected : (l) => l.startupConnectingGw);
          }
          break;
      }
    });
    _eventSub = _ws.events.listen((e) {
      if (_navigated || !mounted) return;
      if (e.event == 'auth_renewed') {
        setState(() => _status = (l) => l.commonCredAutoRenewed);
      } else if (e.event == 'auth_expired') {
        // 【401 改造】凭证层已试过 refresh 且确认不可恢复（本地 token 也已被清）。
        // **复用既有失败态**（_StartupPhase.failed），只把标题/详情/主出口换成「重新登录」，
        // 不新增第五个阶段，避免与上一轮的「失败态四出口」互相矛盾。
        final raw = e.payload['message']?.toString();
        _authExpired = true;
        _pairTimeout?.cancel();
        // 服务端原文原样带入 {msg}（口径④不建映射表）；整句结构由我们自己的词条决定
        _enterFailed(
          (l) => l.startupAuthExpiredTitle,
          (l) => l.startupAuthExpiredDetail(raw ?? l.commonLoginExpiredFallback),
        );
      } else if (e.event == 'error') {
        final raw = e.payload['message']?.toString() ?? '';
        // 普通网络错误 / 「续签暂未完成」都交给 ws 自动重连，这里仅展示状态；
        // 不再像旧版那样靠字符串匹配就把本地 token 清掉、把人踢回登录页。
        setState(() => _status = rawText(raw));
      } else if (e.event == 'devices_list') {
        _awaitingDevices = false;
        _devicesTimeout?.cancel();
        _showDevicePicker(e.payload['devices'] as List? ?? const []);
      } else if (e.event == 'host_offline') {
        // 目标桌面端离线：登录态与网关连接都是好的，**不再干等**——
        // 直接进主界面（主页有「该设备不在线」横幅 + 常驻的重试/切设备/退出入口）。
        _gatewayReached = true;
        if (_pendingDeviceChoice) {
          // 用户正在选设备：不打断弹层，等选择结果
          setState(() => _status = (l) => l.commonHostOfflinePickDevice);
          return;
        }
        _pairTimeout?.cancel();
        _goHome(hostOffline: true);
      } else if (e.event == 'host_online') {
        setState(() => _status = (l) => l.startupHostOnlinePairing);
      }
    });
    _restore();
  }

  /// 武装/重置「恢复等待」超时：任何一次主动连接动作都应重新计时
  void _armTimeout() {
    _pairTimeout?.cancel();
    _pairTimeout = Timer(kStartupPairTimeout, () {
      if (!mounted || _navigated) return;
      // 弹层开着时不抢页面，等用户操作完（超时会在下一次动作重新武装）
      if (_pendingDeviceChoice) return;
      _enterFailed(
        _gatewayReached ? (l) => l.startupTimeoutConnected : (l) => l.startupTimeoutUnreachable,
        _gatewayReached
            ? (l) => l.startupTimeoutConnectedDetail
            : (l) => l.startupTimeoutUnreachableDetail,
      );
    });
  }

  void _enterFailed(L10nText title, L10nText detail) {
    if (!mounted || _navigated) return;
    setState(() {
      _phase = _StartupPhase.failed;
      _busy = false;
      _failTitle = title;
      _failDetail = detail;
    });
  }

  Future<void> _restore() async {
    _armTimeout();
    // 从凭证层恢复登录态（token + 有效期；老数据没 expires_at → 按「未知」处理，不判过期）
    CredentialSnapshot cred;
    try {
      cred = await MemberCredentials.instance.bootstrap();
    } catch (e) {
      // 读本地登录态失败（如 Keystore 异常）：不能让它悄悄吞掉导致永久转圈。
      debugPrint('[startup] 恢复登录态失败: $e');
      try {
        await TokenStore.clear();
      } catch (_) {}
      _goLogin();
      return;
    }
    if (!mounted || _navigated) return;
    final token = cred.state == CredentialState.anonymous ? null : MemberCredentials.instance.accessToken;
    debugPrint('[startup] 凭证恢复: state=${cred.state.name} '
        '来源=${cred.expirySource} token=${token == null ? 'null' : '长度=${token.length}'}');
    if (token == null || token.isEmpty) {
      _goLogin();
      return;
    }
    // 启动即持有续签定时器：定时器在 start() 里会立即检查一次，
    // 覆盖「关机超过 TTL、开机时凭证就已过期」这个旧实现完全漏掉的场景
    // （旧实现只在 ws 握手成功后才可能重连，而握手 401 根本不会成功）。
    MemberCredentials.instance.start(_credOwner);
    // 【补的缺口】本地已判定过期 → 不拿过期 token 去撞 401，先续签再连
    if (cred.state == CredentialState.expired) {
      setState(() => _status = (l) => l.startupCredExpiredRenewing);
      final outcome = await MemberCredentials.instance.refresh('startup-expired');
      if (!mounted || _navigated) return;
      if (outcome == RefreshOutcome.invalid) {
        _authExpired = true;
        final lastErr = MemberCredentials.instance.snapshot.lastError;
        _enterFailed(
          (l) => l.startupAuthExpiredTitle,
          (l) => l.startupAuthExpiredDetail(lastErr ?? l.startupCredGraceOver),
        );
        return;
      }
      if (outcome == RefreshOutcome.transient) {
        // 网关未部署 / 断网：不登出，继续尝试连接（可能仍会 401，由连接层退避兜底）
        if (mounted && !_navigated) setState(() => _status = (l) => l.startupRenewPending);
      }
    }
    // 有可用 token：自动连网关。失效/失败在事件监听里处理；
    // 这里 catch 首次连接异常，避免「正在恢复登录」永久转圈。
    try {
      debugPrint('[startup] 开始 connectRelay url=$kRelayUrl');
      await _ws.connectRelay(kRelayUrl, MemberCredentials.instance.accessToken ?? token);
      debugPrint('[startup] connectRelay 返回');
    } catch (e) {
      debugPrint('[startup] connectRelay 异常: $e');
      // ws 内部已触发自动重连并发出 error 事件；这里给一个明确的等待文案，
      // 最终由超时兜底转失败态（带出口按钮），不再只靠一行灰字提示。
      if (mounted && !_navigated) {
        setState(() => _status = (l) => l.startupGwFailedRetrying);
      }
    }
  }

  // ——————————————————— 出口动作 ———————————————————

  /// 重试当前设备：打断排队中的自动重连与旧连接，立即重新握手
  Future<void> _retry() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _phase = _StartupPhase.restoring;
      _status = (l) => l.startupRetrying;
    });
    _armTimeout();
    final ok = await _ws.reconnectNow();
    if (!mounted || _navigated) return;
    setState(() {
      _busy = false;
      if (!ok) _status = (l) => l.startupRetryStillFailed;
    });
    // 握手成功后是否配对，交给 paired / host_offline / 超时三条路径决定
    if (ok) _maybeGoHomeIfPaired();
  }

  /// 切换其它设备：主动请求设备列表（不再只被动等网关下发）
  Future<void> _switchDevice() async {
    if (_busy) return;
    if (!_ws.listDevices()) {
      // 当前没有可用连接（网关都没连上）：明确告知并顺手重试，不给「点了没反应」的死局
      _snack((l) => l.startupSnackNoGw);
      await _retry();
      final ok2 = _ws.listDevices();
      if (!ok2) {
        _enterFailed(
          (l) => l.startupNoDeviceListTitle,
          (l) => l.startupNoDeviceListDetail,
        );
        return;
      }
    }
    if (!mounted) return;
    setState(() {
      _busy = true;
      _awaitingDevices = true;
      _phase = _StartupPhase.restoring;
      _status = (l) => l.startupFetchingDevices;
    });
    _armTimeout();
    _devicesTimeout?.cancel();
    _devicesTimeout = Timer(kStartupDevicesWait, () {
      if (!mounted || _navigated || !_awaitingDevices) return;
      setState(() {
        _awaitingDevices = false;
        _busy = false;
      });
      _snack((l) => l.startupDevicesTimeoutSnack);
    });
  }

  /// 跳过等待，直接进主界面（登录态有效即可；未连上电脑由主页横幅承接）
  void _skipToHome() {
    _pairTimeout?.cancel();
    _goHome(hostOffline: _ws.state != ConnState.paired);
  }

  /// 退出登录：清本地登录态回登录页（换账号的出口）
  Future<void> _logout() async {
    // 停掉续签定时器并清内存凭证，杜绝「登出后还在打网关续签」
    MemberCredentials.instance.onLoggedOut();
    try {
      await TokenStore.clear();
    } catch (_) {}
    _goLogin();
  }

  // ——————————————————— 跳转与弹层 ———————————————————

  /// 配对成功且当前未在选设备时，进入主页。
  void _maybeGoHomeIfPaired() {
    if (_ws.state == ConnState.paired) _goHome();
  }

  void _goHome({bool hostOffline = false}) {
    if (!mounted || _navigated) return;
    _navigated = true;
    _pairTimeout?.cancel();
    _devicesTimeout?.cancel();
    Navigator.of(context).pushReplacement(
      MaterialPageRoute(builder: (_) => HomePage(ws: _ws, initialHostOffline: hostOffline)),
    );
  }

  void _goLogin() {
    if (_navigated) return;
    if (!mounted) return;
    _navigated = true;
    _pairTimeout?.cancel();
    _devicesTimeout?.cancel();
    // 停止自动重连，避免跳转后孤儿连接继续反复连网关
    unawaited(_ws.dispose());
    Navigator.of(context).pushReplacement(
      MaterialPageRoute(builder: (_) => const LoginPage()),
    );
  }

  /// 同账号多设备在线：弹设备选择器，选中的设备作为 targetDeviceId 重连（与登录页逻辑一致）。
  Future<void> _showDevicePicker(List<dynamic> devices) async {
    if (_navigated || !mounted) return;
    if (_pendingDeviceChoice) return;
    if (devices.isEmpty) {
      // 网关回了空列表：如实提示，不弹一个空白弹层让用户对着空气
      setState(() {
        _busy = false;
        _awaitingDevices = false;
      });
      _snack((l) => l.startupNoOnlineDevices);
      return;
    }
    setState(() {
      _busy = false;
      _awaitingDevices = false;
      _pendingDeviceChoice = true;
      _status = (l) => l.commonMultiDevicesPick;
    });
    final chosen = await showDevicePickerSheet(context, devices);
    if (!mounted || _navigated) return;
    if (chosen == null) {
      // 用户取消：不把他重新关回「只能干等」的状态——转失败态给出其它出口
      setState(() {
        _pendingDeviceChoice = false;
        _busy = false;
      });
      _enterFailed(
        (l) => l.startupNoDeviceChosenTitle,
        (l) => l.startupNoDeviceChosenDetail,
      );
      return;
    }
    setState(() {
      _phase = _StartupPhase.restoring;
      _status = (l) => l.commonConnectingChosenDevice;
    });
    _armTimeout();
    await _ws.switchDevice(chosen);
    if (!mounted || _navigated) return;
    setState(() => _pendingDeviceChoice = false);
    // switchDevice 内部重连后，网关的 connected("connected to host") 可能先于 _pendingDeviceChoice 复位到达，
    // 导致 paired 事件已过、跳转被跳过；这里补一次判断。
    _maybeGoHomeIfPaired();
  }

  void _snack(L10nText text) {
    if (!mounted) return;
    // SnackBar 是即时事件：在弹出的那一刻按当前语言取词（与桌面端系统通知同一口径 ——
    // 已经弹出去的提示条不会随之后的语言切换而改变，这是物理事实）
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
          content: Text(text(AppLocalizations.of(context)), style: const TextStyle(fontSize: 13)),
          duration: const Duration(seconds: 3)),
    );
  }

  @override
  void dispose() {
    _pairTimeout?.cancel();
    _devicesTimeout?.cancel();
    _stateSub?.cancel();
    _eventSub?.cancel();
    _credSub?.cancel();
    // 页面被真正销毁且没跳走（如热重载/退出）：停掉孤儿重连
    if (!_navigated) unawaited(_ws.dispose());
    // 停掉本页持有的续签定时器（owner 不匹配时是空操作，不会误停主页的）
    MemberCredentials.instance.stop(_credOwner);
    super.dispose();
  }

  // ——————————————————— UI ———————————————————

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 32),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: _phase == _StartupPhase.restoring ? _buildRestoring() : _buildFailed(),
            ),
          ),
        ),
      ),
    );
  }

  /// 等待态：转圈 + 文案 + **常驻次要出口**（绝不出现「只有一个转圈」的死局）
  Widget _buildRestoring() {
    final l = AppLocalizations.of(context);
    final accent = Theme.of(context).colorScheme.primary;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Center(child: SizedBox(width: 34, height: 34, child: CircularProgressIndicator(color: accent, strokeWidth: 3))),
        const SizedBox(height: 18),
        Text(_status(l), textAlign: TextAlign.center, style: const TextStyle(fontSize: 13, color: Colors.grey)),
        const SizedBox(height: 6),
        // 数量走 ARB plural（禁止代码里拼「N 秒」）：中文 one/other 同值但形态保留
        Text(l.startupWaitHint(kStartupPairTimeout.inSeconds),
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 11, color: Colors.grey.shade600)),
        const SizedBox(height: 22),
        OutlinedButton.icon(
          onPressed: _busy ? null : _switchDevice,
          icon: const Icon(Icons.devices_other_outlined, size: 18),
          label: Text(l.commonSwitchDevice),
          style: OutlinedButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 13)),
        ),
        const SizedBox(height: 10),
        TextButton(
          onPressed: _skipToHome,
          child: Text(l.startupSkipToHome, style: TextStyle(fontSize: 13, color: Colors.grey.shade400)),
        ),
        TextButton(
          onPressed: _logout,
          child: Text(l.commonLogout, style: TextStyle(fontSize: 13, color: Colors.grey.shade500)),
        ),
      ],
    );
  }

  /// 失败态：如实说明卡在哪一步 + 四个出口（重试 / 切设备 / 进主界面 / 退出登录）
  Widget _buildFailed() {
    final l = AppLocalizations.of(context);
    final c = context.appColors;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          padding: const EdgeInsets.all(18),
          decoration: BoxDecoration(
            color: c.cardBg,
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: c.border),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(Icons.cloud_off_outlined, size: 22, color: c.pending),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(_failTitle(l),
                        style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              Text(_failDetail(l), style: TextStyle(fontSize: 13, height: 1.5, color: c.textSecondary)),
              if (_ws.targetDeviceId != null && _ws.targetDeviceId!.isNotEmpty) ...[
                const SizedBox(height: 10),
                Text(l.startupLastDevice(_ws.targetDeviceId!),
                    style: TextStyle(fontSize: 12, color: c.textMuted)),
              ],
            ],
          ),
        ),
        const SizedBox(height: 18),
        // 凭证失效时主出口改为「重新登录」（同一 failed 阶段，不新增第五态）；
        // 其它失败原因仍以「重试当前设备」为主出口。
        if (_authExpired)
          FilledButton.icon(
            onPressed: _busy ? null : _logout,
            icon: const Icon(Icons.replay, size: 18),
            label: Text(_busy ? l.commonBusyProcessing : l.startupRelogin),
            style: FilledButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 15)),
          )
        else
          FilledButton.icon(
            onPressed: _busy ? null : _retry,
            icon: const Icon(Icons.refresh, size: 18),
            label: Text(_busy ? l.commonBusyProcessing : l.startupRetryCurrentDevice),
            style: FilledButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 15)),
          ),
        const SizedBox(height: 10),
        if (_authExpired)
          OutlinedButton.icon(
            onPressed: _busy ? null : _retry,
            icon: const Icon(Icons.refresh, size: 18),
            label: Text(l.startupRetryAutoRenew),
            style: OutlinedButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 14)),
          )
        else
          OutlinedButton.icon(
            onPressed: _busy ? null : _switchDevice,
            icon: const Icon(Icons.devices_other_outlined, size: 18),
            label: Text(l.commonSwitchDevice),
            style: OutlinedButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 14)),
          ),
        const SizedBox(height: 10),
        OutlinedButton.icon(
          onPressed: _authExpired ? null : _skipToHome,
          icon: const Icon(Icons.login_outlined, size: 18),
          label: Text(_authExpired ? l.startupCredExpiredNoHome : l.startupEnterHome),
          style: OutlinedButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 14)),
        ),
        const SizedBox(height: 6),
        TextButton(
          onPressed: _logout,
          child: Text(_authExpired ? l.startupSwitchAccount : l.commonLogout,
              style: TextStyle(fontSize: 13, color: Colors.grey.shade500)),
        ),
        if (_credHint != null) ...[
          const SizedBox(height: 8),
          Text(_credHint!(AppLocalizations.of(context)), textAlign: TextAlign.center, style: TextStyle(fontSize: 11, color: Colors.grey.shade600)),
        ],
      ],
    );
  }
}
