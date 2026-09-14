// manox-vscode entry point: registers the sidebar conversation view and the
// @manox chat participant, both driving the shared in-process agent host
// (manox-napi) through the v2 protocol. Activation is lazy — nothing starts
// the agent runtime until a surface first needs it.

import * as vscode from 'vscode';
import { AgentHost, configuredApprovalMode } from './agentHost';
import { registerManoxParticipant } from './participant';
import { postToSidebar, registerManoxSidebar } from './sidebar/sidebarProvider';

export function activate(context: vscode.ExtensionContext): void {
	registerManoxSidebar(context);
	registerManoxParticipant(context);
	// Approval-mode switches push the fresh value to the webview (its
	// selector + the setApprovalMode note for the viewed session ride it).
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('manox.approvalMode')) {
				postToSidebar({ t: 'config', approvalMode: configuredApprovalMode() });
			}
		}),
	);
}

export function deactivate(): Thenable<void> {
	return AgentHost.disposeShared();
}
