// manox-vscode entry point: registers the sidebar conversation view and the
// @manox chat participant, both driving the shared in-process agent host
// (manox-napi) through the v2 protocol. Activation is lazy — nothing starts
// the agent runtime until a surface first needs it.
//
// The `/tutor` harness command is NOT provisioned here: the runtime's
// command scan is one-shot inside `napiBinding.start()`, so the write rides
// the synchronous boot path in the `AgentHost` constructor (see
// codechain/command.ts + review #12) — activating can never race it.

import * as vscode from 'vscode';
import { AgentHost, configuredApprovalMode } from './agentHost';
import { codeChainListChains, codeChainOpenChain, codeChainStepTour } from './codechain/registration';
import { registerManoxParticipant } from './participant';
import { postToSidebar, registerManoxSidebar } from './sidebar/sidebarProvider';

export function activate(context: vscode.ExtensionContext): void {
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

/** Palette + keybinding surface for the Code Tutor view. Opening focuses the
 * draggable view and then goes through a quick-pick over the stored chains
 * (§7: chains outlive their session, so this works after reloads; a chain
 * pick routes back through `panel.show`, which swaps the view's content); the
 * tour-step commands are bound `alt+left/right` ONLY while the code-chain
 * webview VIEW holds focus (`focusViewId == manox.tutorView`), so they never
 * collide with the workbench navigate-back/forward (review #13). */
function registerCodeChainCommands(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('manox.codeChain.open', async () => {
			// Reveal the (draggable) tutor view first so the panel is on
			// screen even when the user cancels the quick-pick below.
			void vscode.commands.executeCommand('manox.tutorView.focus');
			const chains = codeChainListChains();
			if (chains.length === 0) {
				await vscode.window.showInformationMessage(
					'manox: no stored Code Tutor chains yet — run /tutor in a conversation.',
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
				{ placeHolder: 'Open a Code Tutor chain' },
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
