import 'dart:async';
import 'package:flutter/material.dart';
import '../l10n/generated/app_localizations.dart';
import '../locale.dart';
import '../theme.dart';
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
  L10nText _status = (l) => '';
  bool _busy = false;

  /// 【判定与文案解耦】原实现靠 `_status.contains('失败'/'请输入'/'错误')` 决定红色，
  /// 也就是把「是不是错误」这件事寄托在中文文案的字面上 —— 文案一旦本地化成英文，
  /// 这个判定就整体失效（错误不再标红）。改成显式布尔，由每个赋值点自己声明。
  /// 服务端原文（口径④不翻）那一路仍沿用原判定，行为与改前逐字一致。
  bool _statusIsError = false;

  static bool _looksLikeErrorZh(String s) =>
      s.contains('失败') || s.contains('请输入') || s.contains('错误');

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
        final raw = e.payload['message']?.toString();
        setState(() {
          // 服务端带回的原文原样呈现（口径④）；没带回才用我们自己的兜底词条
          _status = raw == null ? (l) => l.commonErrorFallback : rawText(raw);
          _statusIsError = raw == null || _looksLikeErrorZh(raw);
          _busy = false;
        });
      }
    });
  }

  Future<void> _connect() async {
    final host = _hostCtrl.text.trim();
    final port = int.tryParse(_portCtrl.text.trim()) ?? 47800;
    if (host.isEmpty) {
      setState(() {
        _status = (l) => l.connectNeedHost;
        _statusIsError = true;
      });
      return;
    }
    setState(() {
      _busy = true;
      _status = (l) => l.commonConnecting;
      _statusIsError = false;
    });
    try {
      await _ws.connect(host, port);
      _ws.pair(_codeCtrl.text.trim());
      if (mounted) {
        setState(() {
          _status = (l) => l.connectPairedPending;
          _statusIsError = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _status = (l) => l.connectFailed('$e');
          _statusIsError = true;
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
                  l.connectSubtitle,
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 14, color: Colors.grey.shade400),
                ),
                const SizedBox(height: 32),
                _field(
                  label: l.connectHostLabel,
                  hint: l.connectHostHint,
                  controller: _hostCtrl,
                  keyboard: TextInputType.url,
                ),
                const SizedBox(height: 16),
                _field(
                  label: l.connectPortLabel,
                  hint: '47800',
                  controller: _portCtrl,
                  keyboard: TextInputType.number,
                ),
                const SizedBox(height: 16),
                _field(
                  label: l.connectCodeLabel,
                  hint: l.connectCodeHint,
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
                  child: Text(_busy ? l.commonConnecting : l.connectAction,
                      style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
                ),
                const SizedBox(height: 16),
                Text(
                  // 状态文案在渲染期才求值 → 用户中途切语言，这一行立刻跟着变
                  _status(l),
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 13, color: _statusIsError ? Colors.redAccent : Colors.grey.shade400),
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
