import { type ReactNode } from "react";

interface CardProps {
  header?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  noPadding?: boolean;
}

export function Card({ header, footer, children, noPadding }: CardProps) {
  return (
    <div className="b-card">
      {header && <div className="b-card-header">{header}</div>}
      <div className={noPadding ? undefined : "b-card-body"}>{children}</div>
      {footer && <div className="b-card-footer">{footer}</div>}
    </div>
  );
}
