import 'dart:async';
import 'package:flutter/material.dart';
import '../services/ws_client.dart';
import 'home_page.dart';

/// 连接配对页：输入桌面端「设置 → 远程连接」里显示的本机地址 + 配对码。
class ConnectPage extends StatefulWidget {
  const ConnectPage({super.key});

  @override
  State<ConnectPage> createState() => _ConnectPageState();
}

class _ConnectPageState extends State<ConnectPage> {
  final _ws = WsClient();
  final _hostCtrl = TextEditingController();
  final _portCtrl = TextEditingController(text: '47800');
  final _codeCtrl = TextEditingController();
  String _status = '';
  bool _busy = false;
  StreamSubscription<ConnState>? _stateSub;
  StreamSubscription<ServerEvent>? _eventSub;

  @override
  void initState() {
    super.initState();
    _stateSub = _ws.stateStream.listen((s) {
      if (s == ConnState.paired && mounted) {
        Navigator.of(context).pushReplacement(
          MaterialPageRoute(builder: (_) => HomePage(ws: _ws)),
        );
      }
    });
    _eventSub = _ws.events.listen((e) {
      if (e.event == 'error' && mounted) {
        setState(() {
          _status = e.payload['message']?.toString() ?? '出错';
          _busy = false;
        });
      }
    });
  }

  Future<void> _connect() async {
    final host = _hostCtrl.text.trim();
    final port = int.tryParse(_portCtrl.text.trim()) ?? 47800;
    if (host.isEmpty) {
      setState(() => _status = '请输入桌面端显示的 IP 地址');
      return;
    }
    setState(() {
      _busy = true;
      _status = '连接中…';
    });
    try {
      await _ws.connect(host, port);
      _ws.pair(_codeCtrl.text.trim());
      if (mounted) setState(() => _status = '已连接，正在配对…');
    } catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _status = '连接失败：$e';
        });
      }
    }
  }

  @override
  void dispose() {
    _stateSub?.cancel();
    _eventSub?.cancel();
    _hostCtrl.dispose();
    _portCtrl.dispose();
    _codeCtrl.dispose();
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
                  '连接桌面端，远程查看与控制会话',
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 14, color: Colors.grey.shade400),
                ),
                const SizedBox(height: 32),
                _field(
                  label: '桌面端 IP 地址',
                  hint: '如 192.168.1.105（见桌面端「设置 → 远程连接」）',
                  controller: _hostCtrl,
                  keyboard: TextInputType.url,
                ),
                const SizedBox(height: 16),
                _field(
                  label: '端口',
                  hint: '47800',
                  controller: _portCtrl,
                  keyboard: TextInputType.number,
                ),
                const SizedBox(height: 16),
                _field(
                  label: '配对码',
                  hint: '6 位数字',
                  controller: _codeCtrl,
                  keyboard: TextInputType.number,
                  obscure: true,
                ),
                const SizedBox(height: 28),
                FilledButton(
                  onPressed: _busy ? null : _connect,
                  style: FilledButton.styleFrom(
                    padding: const EdgeInsets.symmetric(vertical: 16),
                    backgroundColor: accent,
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                  ),
                  child: Text(_busy ? '连接中…' : '连接', style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
                ),
                const SizedBox(height: 16),
                Text(
                  _status,
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 13, color: _status.contains('失败') || _status.contains('请输入') || _status.contains('错误') ? Colors.redAccent : Colors.grey.shade400),
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
