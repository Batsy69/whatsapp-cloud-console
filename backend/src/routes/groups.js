import { Router } from "express";
import { listGroups, createGroup, deleteGroup } from "../db.js";

const router = Router();

router.get("/", (req, res) => {
  res.json(listGroups());
});

router.post("/", (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "name is required" });
  const id = createGroup(name.trim());
  res.json({ id, name: name.trim() });
});

router.delete("/:id", (req, res) => {
  deleteGroup(Number(req.params.id));
  res.json({ ok: true });
});

export default router;
