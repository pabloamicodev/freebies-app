import { type ReactNode } from "react";
import { BackButton } from "./BackButton.js";
import { StatusBadge } from "./StatusBadge.js";

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  backTo?: string;
  backLabel?: string;
  status?: string;
  actions?: ReactNode;
}

export function PageHeader({ title, subtitle, backTo, backLabel, status, actions }: PageHeaderProps) {
  return (
    <div className="b-page-header">
      <div className="b-page-title-row">
        {backTo && <BackButton to={backTo} label={backLabel} />}
        <div>
          <h1 className="b-page-title">{title}</h1>
          {subtitle && (
            <p className="b-text-sm b-text-sub" style={{ margin: "2px 0 0" }}>
              {subtitle}
            </p>
          )}
        </div>
        {status && <StatusBadge status={status} />}
      </div>
      {actions && <div className="b-page-actions">{actions}</div>}
    </div>
  );
}
