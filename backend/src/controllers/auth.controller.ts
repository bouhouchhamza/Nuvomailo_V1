import { registerUser } from "../services/auth.service.js";
import type { Request, Response } from "express";
import { loginUser, currentUser } from "../services/auth.service.js";
import { env } from "../config/env.js";
export const cookieName="nuvomailo_refresh";
export function sessionResponse(res: Response, value: Awaited<ReturnType<typeof loginUser>>) {
  const {refreshToken,...body}=value;
  res.cookie(cookieName,refreshToken,{httpOnly:true,secure:env.NODE_ENV==="production",sameSite:"strict",path:"/api/auth",maxAge:30*86400000});
  res.setHeader("Cache-Control","no-store");
  return res.json(body);
}

export const login = async (req: Request, res: Response) => {
  sessionResponse(res,await loginUser(req.body));
};
export const me = async (req: Request, res: Response) => {
  res.json(await currentUser(req.userId));
};

export const register = async (req: Request, res: Response) => {
  const user = await registerUser(req.body);

  return res.status(201).json({
    message: " user created successfully",
    id: user.id,
    email: user.email,
  });
};
