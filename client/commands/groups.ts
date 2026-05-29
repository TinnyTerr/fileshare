import { api } from "../api";

export async function cmdGroupCreate(args: string[]): Promise<void> {
	const name = args.join(" ").trim();
	if (!name) {
		console.error("Usage: fileshare group create <name>");
		process.exit(1);
	}

	try {
		const g = (await api.groups.create(name)) as any;
		console.log(`✓ Group created: "${g.name}" (id: ${g.id})`);
	} catch (err: any) {
		console.error(`Failed: ${err.message}`);
		process.exit(1);
	}
}

export async function cmdGroupList(): Promise<void> {
	try {
		const { groups } = (await api.groups.list()) as any;
		if (!groups.length) {
			console.log("No groups yet.");
			return;
		}
		console.log("\nGroups:");
		console.log("─".repeat(60));
		for (const g of groups) {
			console.log(
				`  [${g.id}] ${g.name.padEnd(24)} ${g.role.padEnd(8)} ${g.member_count} members`,
			);
		}
	} catch (err: any) {
		console.error(`Failed: ${err.message}`);
		process.exit(1);
	}
}

export async function cmdGroupInfo(args: string[]): Promise<void> {
	const id = args[0];
	if (!id) {
		console.error("Usage: fileshare group info <id>");
		process.exit(1);
	}
	try {
		const g = (await api.groups.get(parseInt(id))) as any;
		console.log(`Group: ${g.name} (id: ${g.id})`);
		console.log(`Created: ${g.created_at}`);
		console.log(`Members (${g.members.length}):`);
		for (const m of g.members) {
			console.log(`  ${m.username.padEnd(32)} ${m.role}`);
		}
	} catch (err: any) {
		console.error(`Failed: ${err.message}`);
		process.exit(1);
	}
}

export async function cmdGroupAddMember(args: string[]): Promise<void> {
	const groupId = args[0];
	const usernameIdx = args.indexOf("--user");
	const username = usernameIdx >= 0 ? args[usernameIdx + 1] : args[1];
	if (!groupId || !username) {
		console.error(
			"Usage: fileshare group add-member <group-id> --user <username> [--role admin|member]",
		);
		process.exit(1);
	}
	const roleIdx = args.indexOf("--role");
	const role = roleIdx >= 0 ? args[roleIdx + 1] : "member";
	try {
		await api.groups.addMember(parseInt(groupId), username, role as any);
		console.log(`✓ Added ${username} to group ${groupId} as ${role}`);
	} catch (err: any) {
		console.error(`Failed: ${err.message}`);
		process.exit(1);
	}
}

export async function cmdGroupRemoveMember(args: string[]): Promise<void> {
	const groupId = args[0];
	const usernameIdx = args.indexOf("--user");
	const username = usernameIdx >= 0 ? args[usernameIdx + 1] : args[1];
	if (!groupId || !username) {
		console.error(
			"Usage: fileshare group remove-member <group-id> --user <username>",
		);
		process.exit(1);
	}
	try {
		const user = (await api.admin.getUser(parseInt(groupId))) as any; // won't work - need username lookup
		// Look up user id via a separate call
		console.error(
			"Use: fileshare group remove-member <group-id> --user-id <id>",
		);
		process.exit(1);
	} catch (err: any) {
		console.error(`Failed: ${err.message}`);
		process.exit(1);
	}
}

export async function cmdGroupRemoveMemberById(args: string[]): Promise<void> {
	const groupId = args[0];
	const uidIdx = args.indexOf("--user-id");
	const userId = uidIdx >= 0 ? args[uidIdx + 1] : args[1];
	if (!groupId || !userId) {
		console.error(
			"Usage: fileshare group remove-member <group-id> --user-id <user-id>",
		);
		process.exit(1);
	}
	try {
		await api.groups.removeMember(parseInt(groupId), parseInt(userId));
		console.log(`✓ Removed user ${userId} from group ${groupId}`);
	} catch (err: any) {
		console.error(`Failed: ${err.message}`);
		process.exit(1);
	}
}

export async function cmdGroupInvite(args: string[]): Promise<void> {
	const groupId = args[0];
	if (!groupId) {
		console.error(
			"Usage: fileshare group invite <group-id> [--password <pw>] [--expires <days>] [--max-uses <n>]",
		);
		process.exit(1);
	}

	const pwIdx = args.indexOf("--password");
	const expIdx = args.indexOf("--expires");
	const maxIdx = args.indexOf("--max-uses");

	const password = pwIdx >= 0 ? args[pwIdx + 1] : undefined;
	const expiresDays = expIdx >= 0 ? parseInt(args[expIdx + 1]!) : undefined;
	const maxUses = maxIdx >= 0 ? parseInt(args[maxIdx + 1]!) : undefined;

	try {
		const result = (await api.groups.createInvite(parseInt(groupId), {
			password,
			expires_days: expiresDays,
			max_uses: maxUses,
		})) as any;
		console.log(`✓ Invite link: ${result.invite_url}`);
		if (password) console.log(`  Password protected`);
		if (result.expires_at) console.log(`  Expires: ${result.expires_at}`);
		if (result.max_uses) console.log(`  Max uses: ${result.max_uses}`);
	} catch (err: any) {
		console.error(`Failed: ${err.message}`);
		process.exit(1);
	}
}

export async function cmdGroupJoin(args: string[]): Promise<void> {
	const token = args[0];
	if (!token) {
		console.error(
			"Usage: fileshare group join <invite-token> [--password <pw>]",
		);
		process.exit(1);
	}

	const pwIdx = args.indexOf("--password");
	const password = pwIdx >= 0 ? args[pwIdx + 1] : undefined;

	try {
		const result = (await api.groups.join(token, password)) as any;
		console.log(`✓ Joined group: "${result.group.name}"`);
	} catch (err: any) {
		if (err.code === "PASSWORD_REQUIRED") {
			console.error(
				"This invite requires a password. Use: fileshare group join <token> --password <pw>",
			);
		} else {
			console.error(`Failed: ${err.message}`);
		}
		process.exit(1);
	}
}

export async function cmdGroupLeave(args: string[]): Promise<void> {
	const groupId = args[0];
	if (!groupId) {
		console.error("Usage: fileshare group leave <group-id>");
		process.exit(1);
	}
	try {
		await api.groups.leave(parseInt(groupId));
		console.log(`✓ Left group ${groupId}`);
	} catch (err: any) {
		console.error(`Failed: ${err.message}`);
		process.exit(1);
	}
}

export async function cmdGroupDelete(args: string[]): Promise<void> {
	const groupId = args[0];
	if (!groupId) {
		console.error("Usage: fileshare group delete <group-id>");
		process.exit(1);
	}
	try {
		await api.groups.delete(parseInt(groupId));
		console.log(`✓ Deleted group ${groupId}`);
	} catch (err: any) {
		console.error(`Failed: ${err.message}`);
		process.exit(1);
	}
}
