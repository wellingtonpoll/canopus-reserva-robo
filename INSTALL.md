# Guia de Instalação

Extensão Canopus Reserva Robô para Chrome. Windows 10/11.

---

## ⚡ Instalação rápida (recomendado)

### Opção A — PowerShell (mais simples)

1. Baixe **`install.ps1`** da [release mais recente](https://github.com/wellingtonpoll/canopus-reserva-robo/releases/latest)
2. **Click DIREITO** em `install.ps1` → **"Executar com PowerShell"**
3. UAC vai pedir Admin → **Sim**
4. Aguarde mensagem **"Instalação concluída!"**
5. Abra Chrome → extensão aparece em até 1 min na barra de extensões

### Opção B — Batch (alternativa)

1. Baixe **`install.bat`** da [release mais recente](https://github.com/wellingtonpoll/canopus-reserva-robo/releases/latest)
2. **Click DIREITO** em `install.bat` → **"Executar como administrador"**
3. UAC → **Sim**
4. Aguarde **"Instalação concluída!"**

---

## 🔧 Troubleshooting

### "A chave HKLM não pode ser modificada"

Significa que o registro do Windows está bloqueando a escrita. Causas mais comuns:

#### 1. UAC não elevou de verdade

**Verificar:** olhe o título da janela. Deve ter **"Administrador:"** no início.

Se NÃO tem:
- Feche
- **Click DIREITO** no instalador → **"Executar como administrador"** (não dê duplo-click)

#### 2. PC corporativo / domínio AD

**Verificar:** abra Chrome → vá em `chrome://policy`. Se aparece no topo:

> _Your browser is managed by your organization_

→ Seu PC está sob GPO da empresa. Cliente sozinho **não consegue** instalar via policy.

**Soluções:**
- Pedir ao **IT da empresa** para adicionar a extensão no force-list corporativo
- Usar opção C (Modo desenvolvedor) abaixo

#### 3. Antivírus bloqueando

Alguns AVs (Avast, Kaspersky, Norton) bloqueiam edição de policies do Chrome.

**Solução:**
- Desabilitar AV temporariamente
- Rodar instalador como Admin
- Reabilitar AV
- Reiniciar Chrome

#### 4. PowerShell Execution Policy bloqueada

Se aparecer `cannot be loaded because running scripts is disabled`:

PowerShell admin:
```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned -Force
```

Depois rodar `install.ps1` novamente.

---

### Opção C — Instalação manual (Modo desenvolvedor)

Quando nem `.ps1` nem `.bat` funcionam (ex: PC corporativo restrito).

1. Baixe **`canopus-reserva-robo.crx`** da release
2. Chrome → digite na barra de endereço: `chrome://extensions`
3. No canto sup. direito, ative **"Modo do desenvolvedor"**
4. Arraste o arquivo `.crx` para dentro da página
5. Chrome pode pedir confirmação → **Adicionar extensão**

**Limitação:** sem instalação automática de updates. Para atualizar, repetir o processo manualmente quando nova release sair.

#### Alternativa C2 — Load Unpacked

Se Chrome bloquear o `.crx` (algumas versões só aceitam via policy):

1. Baixe o `.zip` da release (`canopus-reserva-robo-vX.Y.Z.zip`)
2. Extraia em pasta local (ex: `C:\canopus-robo\`)
3. Chrome → `chrome://extensions` → ative **Modo do desenvolvedor**
4. Clique em **"Carregar sem compactação"**
5. Selecione a pasta extraída

---

## 🧹 Reset / Desinstalação

### Remover policy (limpar instalação anterior)

PowerShell ou cmd **como Administrador**:

```cmd
reg delete "HKLM\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist" /v "1" /f
```

Se receber **"Não foi possível encontrar o registro"**: a chave já não existe — pode prosseguir.

Após remover policy, fechar Chrome completamente e reabrir. A extensão será desinstalada automaticamente em ~1 min.

### Remover extensão manualmente

1. Chrome → `chrome://extensions`
2. Localize "Canopus Reserva Robô"
3. Clique em **Remover**

Atenção: se a policy ainda estiver no registro, Chrome vai reinstalar sozinho. Remover policy primeiro (acima).

---

## ✅ Verificar instalação correta

Após instalação bem-sucedida:

1. Abra Chrome
2. Vá em `chrome://policy`
3. Procure por **`ExtensionInstallForcelist`** na tabela
4. Deve aparecer com o valor:
   ```
   lkeigkjegnfmajemjghejfimbcnjpkio;https://github.com/wellingtonpoll/canopus-reserva-robo/releases/latest/download/update_manifest.xml
   ```
5. Coluna "Status" deve mostrar **OK**

Em seguida:
1. Vá em `chrome://extensions`
2. **Canopus Reserva Robô** deve aparecer como **Ativado**
3. Click no ícone do robô na barra de extensões → abre side panel

---

## 📞 Suporte

Problemas de instalação não resolvidos por este guia: abrir [issue no GitHub](https://github.com/wellingtonpoll/canopus-reserva-robo/issues) com:

- Versão do Windows (`winver` → tirar print)
- Print do `chrome://policy`
- Print do erro exato no instalador
- Antivírus utilizado
