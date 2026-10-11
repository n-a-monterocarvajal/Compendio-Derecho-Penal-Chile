#!/usr/bin/env bash
# Resume el estado de GitHub para el cuerpo de un issue de falla. Nunca falla: si
# githubstatus.com no responde, lo dice y el aviso se abre igual.
set -uo pipefail

resumen=$(curl -fsS --max-time 15 https://www.githubstatus.com/api/v2/summary.json | jq -r '
  def es:
    {
      "operational": "operativo",
      "degraded_performance": "rendimiento degradado",
      "partial_outage": "caída parcial",
      "major_outage": "caída total",
      "under_maintenance": "en mantención"
    }[.] // .;
  "- Estado general: \(.status.description)",
  (.components[] | select(.name == "Actions") | "- GitHub Actions: \(.status | es)"),
  (if (.incidents | length) == 0
    then "- Sin incidentes abiertos."
    else (.incidents[] | "- Incidente abierto: \(.name) (\(.status), \(.shortlink))")
  end)
' 2>/dev/null) || resumen=""
if [ -z "$resumen" ]; then
  resumen="- No se pudo consultar githubstatus.com."
fi

echo "### Estado de GitHub al momento del aviso"
echo
echo "$resumen"
echo
echo "Fuente: https://www.githubstatus.com"
