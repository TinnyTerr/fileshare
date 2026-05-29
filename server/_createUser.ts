import { db } from "./db";

type CreateUserInput = {
	username: string;
	password: string;
	role?: string;
	subscriptionTier?: string;
};

export async function createUser({
	username,
	password,
	role = "user",
	subscriptionTier = "free",
}: CreateUserInput) {
	// Hash password
	const passwordHash = await Bun.password.hash(password);

	// Insert user
	const query = db.query(`
    INSERT INTO users (
      email,
      password_hash,
      role,
      subscription_tier
    )
    VALUES (?, ?, ?, ?)
    RETURNING *
  `);

	const user = query.get(username, passwordHash, role, subscriptionTier);

	return user;
}
