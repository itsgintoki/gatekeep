import { Router } from "express";
import * as ResolveController from "./resolve.controller";

const router = Router();

router.get("/:slug", ResolveController.resolveGet);
router.post("/:slug", ResolveController.resolvePost);

export default router;
