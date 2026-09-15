// manox-vscode entry point: registers the sidebar conversation view and the
// @manox chat participant, both driving the shared in-process agent host
// (manox-napi) through the v2 protocol. Activation is lazy — nothing starts
// the agent runtime until a surface first needs it.
//
// Code-chain provisioning rides that laziness boundary: the `/codechain`
// slash command is a markdown file in `<MANOX_HOME>/commands/` that the
// agent server scans ONCE at startup (manox command.rs), so it must land
// before the first `AgentHost.shared()` — activation is the only hook
// guaranteed to precede it.

import * as vscode from 'vscode';
import { AgentHost, configuredApprovalMode, configuredStateRoot } from './agentHost';
import { provisionCodeChainCommand } from './codechain/command';
import { codeChainListChains, codeChainOpenChain, codeChainStepTour } from './codechain/registration';
import { registerManoxParticipant } from './participant';
import { postToSidebar, registerManoxSidebar } from './sidebar/sidebarProvider';
import { errorText } from './util';

export function activate(context: vscode.ExtensionContext): void {
	// Before any surface can boot the agent: write (or refresh) the
	// harness command file. Failures never block activation — a missing
	// /codechain degrades to the model's documented no-command path.
	void provisionCodeChainCommand(configuredStateRoot()).catch((e) => {
		console.warn('manox: /codechain command provisioning failed:', errorText(e));
	});

	registerManoxSidebar(context);
	registerManoxParticipant(context);
	registerCodeChainCommands(context);
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

/** Palette + keybinding surface for the code-chain panel. Opening goes
 * through a quick-pick over the stored chains (§7: chains outlive their
 * session, so this works after reloads); the tour steps are window-global
 * `alt+left/right` so the editor can walk a tour from any focus (§6.3). */
function registerCodeChainCommands(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('manox.codeChain.open', async () => {
			const chains = codeChainListChains();
			if (chains.length === 0) {
				await vscode.window.showInformationMessage(
					'manox: no stored code chains yet — run /codechain in a conversation.',
				);
				return;
			}
			const picked = await vscode.window.showQuickPick(
				chains.map((chain) => ({
					label: `$(link) ${chain.title}`,
					description: `${chain.nodeCount} nodes${chain.unresolvedCount ? ` · ${chain.unresolvedCount} unresolved` : ''}`,
					detail: new Date(chain.createdAt).toLocaleString(),
					chainId: chain.chainId,
				})),
				{ placeHolder: 'Open a code chain' },
			);
			if (picked && !codeChainOpenChain(picked.chainId)) {
				await vscode.window.showWarningMessage('manox: that chain is no longer stored.');
			}
		}),
		vscode.commands.registerCommand('manox.codeChain.next', () => codeChainStepTour('next')),
		vscode.commands.registerCommand('manox.codeChain.prev', () => codeChainStepTour('prev')),
	);
}

export function deactivate(): Thenable<void> {
	return AgentHost.disposeShared();
}
