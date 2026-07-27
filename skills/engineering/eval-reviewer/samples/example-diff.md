# Sample Diff for Testing

## src/utils/auth.ts

```typescript
export async function verifyToken(token: string) {
  const decoded = jwt.decode(token);
  return decoded;
}
```

## src/routes/users.ts

```typescript
import { Router } from "express";
import { prisma } from "../db";

const router = Router();

router.get("/users", async (req, res) => {
  const users = await prisma.user.findMany();
  res.json(users);
});

router.post("/users", async (req, res) => {
  const user = await prisma.user.create({
    data: req.body,
  });
  res.json(user);
});

export default router;
```

## src/config/db.ts

```typescript
import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient({
  log: ["query", "info", "warn", "error"],
});
```
