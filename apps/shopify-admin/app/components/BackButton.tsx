import { Link } from "react-router";

interface BackButtonProps {
  to: string;
  label?: string;
}

export function BackButton({ to, label = "← Back" }: BackButtonProps) {
  return (
    <Link to={to} className="b-btn b-btn-secondary b-btn-sm" style={{ textDecoration: "none" }}>
      {label}
    </Link>
  );
}
