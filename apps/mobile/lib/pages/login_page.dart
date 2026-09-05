import 'dart:async';
import 'package:flutter/material.dart';
import '../l10n/generated/app_localizations.dart';
import '../locale.dart';
import '../theme.dart';
import '../services/auth_service.dart';
import '../services/member_credentials.dart';
import '../services/ws_client.dart';
import '../widgets/device_picker.dart';
import 'home_page.dart';
import 'connect_page.dart';

/// 登录基地址（会员体系，登录换 JWT）
const kLoginBaseUrl = 'https://agent.bjctykj.com';
/// 网关中继地址（桌面端 Host 与手机端 Client 都连这里，外网可达）
const kRelayUrl = 'wss://aisocket.bjctykj.com/ws';

/// 登录/启动后等待「配对到桌面端」的超时兜底：到点仍未配对就不再干等，
/// 转入可操作状态（进主界面看离线横幅，或留在原页给提示）。启动页共用此常量。
const Duration kStartupPairTimeout = Duration(seconds: 12);

/// 登录页：会员账号密码登录（密码 SHA-256），拿到 JWT 后作为 Client 连网关中继，
/// 与桌面端 Host（同一账号登录）自动配对。底部提供「局域网直连」入口作为兜底。
class LoginPage extends StatefulWidget {
  const LoginPage({super.key});

  @override
  State<LoginPage> createState() => _LoginPageState();
}

class _LoginPageState extends State<LoginPage> {
  final _ws = WsClient();
  final _userCtrl = TextEditingController();
  final _passCtrl = TextEditingController();
  /// 存「怎么取词」而不是「取到的词」：本字段是 state，若直接存已翻译好的字符串，
  /// 用户中途切语言后这里仍是旧语言（桌面端历轮反复踩的「文案烘进 state」坑）。
  L10nText _status = (l) => '';
  bool _busy = false;

  /// 【判定与文案解耦】原实现用 `_status.contains('失败'/'请输入')` 决定红色，
  /// 即把「是不是错误」寄托在中文文案字面上 —— 文案翻成英文后判定整体失效。
  /// 改成各赋值点显式声明；服务端原文那两路仍按原中文字面判定（口径④不翻原文），
  /// 因此中文态的颜色结果与改前逐字一致。
  bool _statusIsError = false;

  static bool _looksLikeErrorZh(String s) => s.contains('失败') || s.contains('请输入');

  bool _pendingDeviceChoice = false;

  /// 已连上网关（哪怕目标桌面端离线）：登录页据此决定超时后是「进主界面」还是「留在本页重试」
  bool _gatewayReached = false;

  /// 已发起跳转：之后所有连接回调一律忽略
  bool _navigated = false;

  /// 登录后等待配对的超时兜底（避免「连接中…」永久转圈）
  Timer? _waitTimeout;

  /// 凭证续签定时器的归属标记：本页 dispose 时只有「自己还是 owner」才停表，
  /// 避免「登录成功→pushReplacement 进主页」时把主页刚启动的续签定时器一起停掉。
  static const _credOwner = 'login-page';

  /// 凭证状态提示（三态如实呈现：有效 / 即将到期已续签 / 有效期未知）
  // 存「怎么取词」而不是「取到的词」：它在事件回调里被 setState 一次，存字符串会把语言烘进 state
  L10nText? _credHint;

  StreamSubscription<ConnState>? _stateSub;
  StreamSubscription<ServerEvent>? _eventSub;
  StreamSubscription<CredentialSnapshot>? _credSub;

  @override
  void initState() {
    super.initState();
    // 订阅凭证状态：登录成功后如实显示「凭证剩余有效期 / 有效期未知」，
    // 让用户知道「这次是不是真的登录上了、什么时候会再需要登录」
    _credSub = MemberCredentials.instance.status.listen((snap) {
      if (!mounted || _navigated) return;
      setState(() => _credHint = snap.state == CredentialState.anonymous ? null : snap.describe());
    });
    _stateSub = _ws.stateStream.listen((s) {
      if (_navigated || !mounted) return;
      // 配对到具体 Host：直接进主页
      if (s == ConnState.paired) {
        _waitTimeout?.cancel();
        _goHome();
      } else if (s == ConnState.connected) {
        // 已连上网关但尚未配对到 Host：明确提示「等待桌面端上线」，
        // 避免握手成功后、网关未下发任何事件时，文案一直卡在「登录成功，连接中…」。
        _gatewayReached = true;
        setState(() {
          _status = (l) => l.commonGwConnectedWaitingHost;
          _statusIsError = false;
        });
      }
    });
    _eventSub = _ws.events.listen((e) {
      if (_navigated || !mounted) return;
      if (e.event == 'auth_renewed') {
        // 凭证层自动续签成功：如实提示，不打断连接
        setState(() {
          _status = (l) => l.commonCredAutoRenewed;
          _statusIsError = false;
        });
        return;
      }
      if (e.event == 'auth_expired') {
        // 【401 改造】只有「refresh 也确认不可恢复」才会走到这里（凭证层已清掉本地 token）。
        // 之前这里靠字符串匹配 error 就把 token 清了，网关一抖动用户就被踢下线。
        final raw = e.payload['message']?.toString();
        setState(() {
          // 服务端带回的原文原样呈现（口径④）；没带回才用我们自己的兜底词条
          _status = raw == null ? (l) => l.commonLoginExpiredFallback : rawText(raw);
          _statusIsError = raw != null && _looksLikeErrorZh(raw);
          _busy = false;
        });
        return;
      }
      if (e.event == 'error') {
        final raw = e.payload['message']?.toString();
        // 普通网络/网关错误：交给 ws 自动重连，这里只更新文案，**不再清登录态**
        setState(() {
          _status = raw == null ? (l) => l.commonErrorFallback : rawText(raw);
          _statusIsError = raw != null && _looksLikeErrorZh(raw);
          _busy = false;
        });
      } else if (e.event == 'devices_list') {
        _showDevicePicker(e.payload['devices'] as List? ?? const []);
      } else if (e.event == 'host_offline') {
        // 登录态与连接态解耦：账号已登录、网关已连通，只是那台电脑不在线——
        // 不再把人关在登录页干等，直接放行进主界面（主页有离线横幅 + 重试/切设备/退出入口）。
        _gatewayReached = true;
        if (_pendingDeviceChoice) {
          setState(() {
            _status = (l) => l.commonHostOfflinePickDevice;
            _statusIsError = false;
          });
          return;
        }
        _waitTimeout?.cancel();
        _goHome(hostOffline: true);
      }
    });
  }

  /// 登录/连接后的等待超时兜底：到点仍未配对，就按「能否连上网关」分别处理，绝不永久转圈
  void _armWaitTimeout() {
    _waitTimeout?.cancel();
    _waitTimeout = Timer(kStartupPairTimeout, () {
      if (!mounted || _navigated || _pendingDeviceChoice) return;
      if (_ws.state == ConnState.paired) {
        _goHome();
        return;
      }
      if (_gatewayReached) {
        // 网关正常、只是桌面端不在线：放行进主界面
        _goHome(hostOffline: true);
        return;
      }
      // 连网关都连不上：留在登录页，恢复按钮并给明确指引（表单仍在，不算死局）
      setState(() {
        _busy = false;
        _status = (l) => l.loginGwUnreachable;
        _statusIsError = false;
      });
    });
  }

  /// 进入主页（hostOffline=true 时主页会显示「该设备当前不在线」横幅）
  void _goHome({bool hostOffline = false}) {
    if (!mounted || _navigated) return;
    _navigated = true;
    _waitTimeout?.cancel();
    Navigator.of(context).pushReplacement(
      MaterialPageRoute(builder: (_) => HomePage(ws: _ws, initialHostOffline: hostOffline)),
    );
  }

  /// 同账号多设备在线：弹设备选择器，选中的设备作为 targetDeviceId 重连。
  Future<void> _showDevicePicker(List<dynamic> devices) async {
    if (_pendingDeviceChoice) return; // 防止重复弹出
    if (devices.isEmpty) {
      // 网关回了空列表：如实提示，不弹空白弹层让用户对着空气
      setState(() {
        _busy = false;
        _status = (l) => l.loginNoDevices;
        _statusIsError = false;
      });
      return;
    }
    setState(() {
      _pendingDeviceChoice = true;
      _status = (l) => l.commonMultiDevicesPick;
      _statusIsError = false;
    });
    final chosen = await showDevicePickerSheet(context, devices);
    if (!mounted || _navigated) return;
    if (chosen == null) {
      // 用户取消：恢复按钮，允许再次触发（不把人关在只能干等的状态）
      setState(() {
        _pendingDeviceChoice = false;
        _busy = false;
        _status = (l) => l.loginNoDeviceChosen;
        _statusIsError = false;
      });
      return;
    }
    setState(() {
      _status = (l) => l.commonConnectingChosenDevice;
      _statusIsError = false;
    });
    _armWaitTimeout();
    await _ws.switchDevice(chosen);
    if (!mounted || _navigated) return;
    setState(() => _pendingDeviceChoice = false);
    // switchDevice 内部重连后，网关的 connected("connected to host") 可能先于 _pendingDeviceChoice 复位到达，
    // 导致 paired 事件已过、跳转被跳过；这里补一次判断。
    _goHomeIfPaired();
  }

  /// 已配对则进主页（用于事件错过后的补判）
  void _goHomeIfPaired() {
    if (_ws.state == ConnState.paired) _goHome();
  }

  Future<void> _login() async {
    final u = _userCtrl.text.trim();
    final p = _passCtrl.text;
    if (u.isEmpty || p.isEmpty) {
      setState(() {
        _status = (l) => l.loginNeedCredentials;
        _statusIsError = true;
      });
      return;
    }
    setState(() {
      _busy = true;
      _gatewayReached = false;
      _status = (l) => l.loginBusy;
      _statusIsError = false;
    });
    // 超时兜底：登录/连接握手最坏 15s，这里 12s 到点先给出结果，避免按钮永久「连接中…」
    _armWaitTimeout();
    try {
      final result = await AuthService(baseUrl: kLoginBaseUrl).login(u, p);
      if (!mounted || _navigated) return;
      // 登录成功：token + 有效期一并交给凭证层持久化（跨重启自动登录），由它统一负责
      // 「到期前主动续签 / 401 被动续签 / 失败分类」。之前这里只存 token、没有有效期概念，
      // 过期后只能靠握手 401 被踢回登录页。
      await MemberCredentials.instance.applyLogin(
        token: result.token,
        username: u,
        expiresAtMs: result.expiresAtMs,
        ttlSeconds: result.ttlSeconds,
        owner: _credOwner,
      );
      setState(() {
        final expiryKnown = result.expiryKnown;
        _status = expiryKnown ? (l) => l.loginSuccess : (l) => l.loginSuccessNoExpiry;
        _statusIsError = false;
      });
      await _ws.connectRelay(kRelayUrl, result.token);
      if (mounted && !_navigated) _goHomeIfPaired();
    } catch (e) {
      if (mounted && !_navigated) {
        _waitTimeout?.cancel();
        setState(() {
          _busy = false;
          _status = (l) => l.loginFailed('$e');
          _statusIsError = true;
        });
      }
    }
  }

  void _openLan() {
    Navigator.of(context).push(
      MaterialPageRoute(builder: (_) => const ConnectPage()),
    );
  }

  @override
  void dispose() {
    _waitTimeout?.cancel();
    _stateSub?.cancel();
    _eventSub?.cancel();
    _credSub?.cancel();
    _userCtrl.dispose();
    _passCtrl.dispose();
    // 未跳转就被销毁（如切去局域网直连页后退出）：停掉孤儿重连
    if (!_navigated) unawaited(_ws.dispose());
    // 停掉本页持有的续签定时器（owner 不匹配时是空操作，不会误停主页的）
    MemberCredentials.instance.stop(_credOwner);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final accent = Theme.of(context).colorScheme.primary;
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 32),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const SizedBox(height: 16),
                Icon(Icons.hub_outlined, size: 64, color: accent),
                const SizedBox(height: 16),
                Text(
                  l.brandShanhai,
                  textAlign: TextAlign.center,
                  style: const TextStyle(fontSize: 28, fontWeight: FontWeight.w700, letterSpacing: 4),
                ),
                const SizedBox(height: 8),
                Text(
                  l.loginSubtitle,
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 14, color: Colors.grey.shade400),
                ),
                const SizedBox(height: 32),
                _field(
                  label: l.loginAccountLabel,
                  hint: l.loginAccountHint,
                  controller: _userCtrl,
                  keyboard: TextInputType.text,
                ),
                const SizedBox(height: 16),
                _field(
                  label: l.loginPasswordLabel,
                  hint: l.loginPasswordHint,
                  controller: _passCtrl,
                  obscure: true,
                ),
                const SizedBox(height: 28),
                FilledButton(
                  onPressed: _busy ? null : _login,
                  style: FilledButton.styleFrom(
                    padding: const EdgeInsets.symmetric(vertical: 16),
                    backgroundColor: accent,
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                  ),
                  child: Text(_busy ? l.commonConnecting : l.loginAction,
                      style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
                ),
                const SizedBox(height: 16),
                Text(
                  // 渲染期才求值 → 中途切语言这一行立刻跟着变
                  _status(l),
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 13, color: _statusIsError ? Colors.redAccent : Colors.grey.shade400),
                ),
                // 凭证三态如实呈现（已登录有效 / 即将到期已续签 / 有效期未知）
                if (_credHint != null) ...[
                  const SizedBox(height: 6),
                  Text(
                    _credHint!(AppLocalizations.of(context)),
                    textAlign: TextAlign.center,
                    style: TextStyle(fontSize: 11.5, color: Colors.grey.shade500),
                  ),
                ],
                const SizedBox(height: 24),
                TextButton(
                  onPressed: _openLan,
                  child: Text(l.loginLanDirect, style: TextStyle(fontSize: 13, color: Colors.grey.shade400)),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _field({
    required String label,
    required String hint,
    required TextEditingController controller,
    TextInputType? keyboard,
    bool obscure = false,
  }) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
        const SizedBox(height: 8),
        TextField(
          controller: controller,
          keyboardType: keyboard,
          obscureText: obscure,
          decoration: InputDecoration(
            hintText: hint,
            hintStyle: TextStyle(fontSize: 13, color: Colors.grey.shade600),
            filled: true,
            fillColor: context.appColors.cardBg,
            contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
            border: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: BorderSide.none),
          ),
        ),
      ],
    );
  }
}
