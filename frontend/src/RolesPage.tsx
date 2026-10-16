import { useEffect, useState } from "react";
import { api, errorText, PERMISSION_LABELS, RoleItem } from "./api";

export function RolesPage() {
  const [roles, setRoles] = useState<RoleItem[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    api<RoleItem[]>("/api/roles")
      .then(setRoles)
      .catch((reason) => setError(errorText(reason)));
  }, []);

  return (
    <div className="stack">
      <div>
        <h1>角色</h1>
        <p className="muted">默认角色在创建 Team 里的 Agent 时选用。也可以在那时新建角色。</p>
      </div>
      {error && <div className="alert">{error}</div>}
      <div className="card">
        <table>
          <thead><tr><th>角色</th><th>职责</th><th>权限</th></tr></thead>
          <tbody>
            {roles.map((role) => (
              <tr key={role.id}>
                <td>
                  {role.name}
                  <div className="meta">{role.code}{role.isBuiltin ? " · 默认" : ""}</div>
                </td>
                <td>{role.duties}</td>
                <td>{role.permissions.map((permission) => PERMISSION_LABELS[permission] ?? permission).join("、")}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {roles.length === 0 && !error && <p className="muted">还没有角色。</p>}
      </div>
    </div>
  );
}
