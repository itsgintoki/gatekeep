import { Router } from "express";
import * as LinksController from "./links.controller";
import { authenticate } from "../../middleware/authenticate";

const router = Router();

router.use(authenticate);

router.post("/", LinksController.createLink);
router.get("/", LinksController.listLinks);
router.get("/:id", LinksController.getLink);
router.delete("/:id", LinksController.deleteLink);

export default router;
