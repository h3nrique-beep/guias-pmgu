# SISGLOSA

Versão 1.1.2. Aplicação local para elaborar guias de ajuste e glosa, com pré-visualização e impressão no padrão do documento PMGU.

## Requisitos

- Node.js 22.5 ou superior

## Executar

```powershell
npm start
```

Abra `http://localhost:8081`.

No primeiro acesso, use `admin` e `admin123`. Crie outro usuário antes de registrar dados reais.

## Recursos

- Guias de ajuste e glosa por módulos.
- Especialidade e CRM somente em honorários.
- Cálculo: valor auditado = apresentado - (glosa + ajuste).
- Justificativa padrão nos módulos de ajuste, com valor editável.
- Pré-visualização e impressão/PDF conforme o modelo ODT.
- Rascunho separado por aba e criação de várias guias simultaneamente.
- Banco SQLite local em `data/guias.db`.

## Comandos

```powershell
npm run check
npm start
```

O sistema é local e usa a porta `8081` por padrão. Para outra porta, defina `PORT` antes de iniciar.
