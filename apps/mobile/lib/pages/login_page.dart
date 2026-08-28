import 'dart:async';
import 'package:flutter/material.dart';
import '../services/auth_service.dart';
import '../services/token_store.dart';
import '../services/ws_client.dart';
import '../widgets/device_picker.dart';
import 'home_page.dart';
import 'connect_page.dart';

/// 登录基地址（会员体系，登录换 JWT）
const kLoginBaseUrl = 'https://agent.bjctykj.com';
/// 网关中继地址（桌面端 Host 与手机端 Client 都连这里，外网可达）
const kRelayUrl = 'wss://aisocket.bjctykj.com/ws';

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
  String _status = '';
  bool _busy = false;
  bool _pendingDeviceChoice = false;
  StreamSubscription<ConnState>? _stateSub;
  StreamSubscription<ServerEvent>? _eventSub;

  @override
  void initState() {
    super.initState();
    _stateSub = _ws.stateStream.listen((s) {
      // 只有真正配对到具体 Host（paired）才进主页；connected 仅表示连上了网关，
      // 可能还处于「Host 离线」或「多设备待选」状态，此时不能进主页（否则 devices_list 会在跳转竞态中丢失）。
      if (s == ConnState.paired) {
        _maybeGoHome();
      } else if (s == ConnState.connected && mounted) {
        // 已连上网关但尚未配对到 Host：明确提示「等待桌面端上线」，
        // 避免握手成功后、网关未下发任何事件时，文案一直卡在「登录成功，连接中…」。
        setState(() => _status = '已连接网关，等待桌面端上线…');
      }
    });
    _eventSub = _ws.events.listen((e) {
      if (e.event == 'error' && mounted) {
        final msg = e.payload['message']?.toString() ?? '出错';
        // token 失效/过期：清本地登录态并提示重新登录（与普通网络错误区分开）
        if (_isTokenInvalid(msg)) {
          TokenStore.clear();
          setState(() {
            _status = '登录已过期，请重新登录';
            _busy = false;
          });
          return;
        }
        setState(() {
          _status = msg;
          _busy = false;
        });
      } else if (e.event == 'devices_list' && mounted) {
        _showDevicePicker(e.payload['devices'] as List? ?? const []);
      } else if (e.event == 'host_offline' && mounted) {
        setState(() {
          _status = '桌面端离线，等待重新连接…';
          _busy = false;
        });
      }
    });
  }

  /// 配对成功且当前未在选设备时，进入主页。
  void _maybeGoHome() {
    if (mounted && !_pendingDeviceChoice && _ws.state == ConnState.paired) {
      Navigator.of(context).pushReplacement(
        MaterialPageRoute(builder: (_) => HomePage(ws: _ws)),
      );
    }
  }

  /// 判断网关 error 消息是否为「登录态失效」：含 token 过期/无效/未授权/401 关键字。
  static bool _isTokenInvalid(String msg) {
    final m = msg.toLowerCase();
    return m.contains('invalid token') ||
        m.contains('expired') ||
        m.contains('unauthorized') ||
        m.contains('401') ||
        m.contains('token') && (m.contains('无效') || m.contains('过期'));
  }

  /// 同账号多设备在线：弹设备选择器，选中的设备作为 targetDeviceId 重连。
  Future<void> _showDevicePicker(List<dynamic> devices) async {
    if (_pendingDeviceChoice) return; // 防止重复弹出
    setState(() {
      _pendingDeviceChoice = true;
      _status = '检测到多台桌面端设备，请选择要连接的设备';
    });
    final chosen = await showDevicePickerSheet(context, devices);
    if (chosen == null) {
      // 用户取消：保持等待，允许再次触发
      setState(() => _pendingDeviceChoice = false);
      return;
    }
    if (!mounted) return;
    setState(() => _status = '正在连接所选设备…');
    await _ws.switchDevice(chosen);
    if (mounted) setState(() => _pendingDeviceChoice = false);
    // switchDevice 内部重连后，网关的 connected("connected to host") 可能先于 _pendingDeviceChoice 复位到达，
    // 导致 paired 事件已过、跳转被跳过；这里补一次判断。
    if (mounted) _maybeGoHome();
  }

  Future<void> _login() async {
    final u = _userCtrl.text.trim();
    final p = _passCtrl.text;
    if (u.isEmpty || p.isEmpty) {
      setState(() => _status = '请输入账号和密码');
      return;
    }
    setState(() {
      _busy = true;
      _status = '登录中…';
    });
    try {
      final token = await AuthService(baseUrl: kLoginBaseUrl).login(u, p);
      if (!mounted) return;
      // 登录成功先持久化登录态（跨重启自动登录），再连网关
      await TokenStore.save(token, u);
      setState(() => _status = '登录成功，连接中…');
      await _ws.connectRelay(kRelayUrl, token);
    } catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _status = '登录失败：$e';
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
    _stateSub?.cancel();
    _eventSub?.cancel();
    _userCtrl.dispose();
    _passCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
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
                const Text(
                  '山海',
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 28, fontWeight: FontWeight.w700, letterSpacing: 4),
                ),
                const SizedBox(height: 8),
                Text(
                  '登录后远程查看与控制桌面端会话',
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 14, color: Colors.grey.shade400),
                ),
                const SizedBox(height: 32),
                _field(
                  label: '账号',
                  hint: '会员账号',
                  controller: _userCtrl,
                  keyboard: TextInputType.text,
                ),
                const SizedBox(height: 16),
                _field(
                  label: '密码',
                  hint: '会员密码',
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
                  child: Text(_busy ? '连接中…' : '登录并连接', style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
                ),
                const SizedBox(height: 16),
                Text(
                  _status,
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 13, color: _status.contains('失败') || _status.contains('请输入') ? Colors.redAccent : Colors.grey.shade400),
                ),
                const SizedBox(height: 24),
                TextButton(
                  onPressed: _openLan,
                  child: Text('局域网直连（同一 WiFi）', style: TextStyle(fontSize: 13, color: Colors.grey.shade400)),
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
            fillColor: const Color(0xFF1A1A24),
            contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
            border: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: BorderSide.none),
          ),
        ),
      ],
    );
  }
}
