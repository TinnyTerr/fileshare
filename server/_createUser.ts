import { db } from "./db";

type CreateUserInput = {
	email: string;
	password: string;
	role?: string;
	subscriptionTier?: string;
};

export async function createUser({
	email,
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

	const user = query.get(email, passwordHash, role, subscriptionTier);

	return user;
}
