import 'package:flutter/material.dart';
import '../locale.dart';
import '../l10n/generated/app_localizations.dart';

/// 弹出设备选择器（底部弹层），返回选中的 deviceId；用户取消返回 null。
Future<String?> showDevicePickerSheet(BuildContext context, List<dynamic> devices) {
  return showModalBottomSheet<String>(
    context: context,
    backgroundColor: const Color(0xFF1A1A24),
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
    ),
    builder: (ctx) => _DevicePickerSheet(devices: devices),
  );
}

/// 设备选择器底部弹层：列出同账号下在线的桌面端设备，点选后返回 deviceId。

/// context-free 取词入口：沿用 7B 在 tool_step.dart 建立的同一形态（同一 resolvedLocale、同一份 ARB）。
/// 【为什么不在这里用 AppLocalizations.of(context)】of() 在 nullable-getter:false 下要求祖先必须装好
/// AppLocalizations.delegates；仓库既有测试 chat_view_scroll_test 就是把本组件挂在只带默认 delegate 的
/// MaterialApp 下跑的，of() 会直接抛 Null check operator。_l 不依赖祖先节点，且 7B 的 LS3 已实测
/// 「locale 变化会重建整棵页面子树 → context-free 取词同样跟切」，所以这里不是绕路，是同一套机制。
AppLocalizations get _l => lookupAppLocalizations(resolvedLocale(LocaleController.instance.value));
class _DevicePickerSheet extends StatelessWidget {
  final List<dynamic> devices;
  const _DevicePickerSheet({required this.devices});

  @override
  Widget build(BuildContext context) {
    final l = _l;
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(l.devicePickerTitle, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
            const SizedBox(height: 4),
            Text(l.devicePickerHint, style: TextStyle(fontSize: 13, color: Colors.grey.shade500)),
            const SizedBox(height: 16),
            ...devices.map((d) {
              final m = (d as Map?)?.cast<String, dynamic>() ?? const <String, dynamic>{};
              final id = m['deviceId']?.toString() ?? '';
              // deviceName 是对端数据，有值原样呈现；缺失才用我们的兜底
              final name = m['deviceName']?.toString() ?? l.deviceUnnamed;
              final hostname = m['hostname']?.toString() ?? '';
              final os = m['os']?.toString() ?? '';
              final clientCount = m['clientCount'] ?? 0;
              return ListTile(
                onTap: () => Navigator.of(context).pop(id),
                leading: const Icon(Icons.computer_outlined, size: 18),
                title: Text(name, style: const TextStyle(fontSize: 14)),
                // 量词进词条（plural）；分隔符也走词条，英文不再露全角顿号/中点
                subtitle: Text([hostname, os, l.deviceClients(clientCount is int ? clientCount : int.tryParse('$clientCount') ?? 0)]
                    .where((s) => s.isNotEmpty)
                    .join(l.sepMiddle), style: const TextStyle(fontSize: 12)),
                trailing: const Icon(Icons.chevron_right, size: 18),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                tileColor: const Color(0xFF22222E),
                contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
              );
            }),
          ],
        ),
      ),
    );
  }
}
