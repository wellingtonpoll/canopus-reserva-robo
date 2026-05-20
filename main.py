import asyncio
import tkinter as tk
from tkinter import scrolledtext, messagebox
import threading
import random
from datetime import datetime
import json
from pathlib import Path
import aiohttp
from aiohttp import ClientSession, TCPConnector
import logging

# Configuração básica de logging
logging.basicConfig(level=logging.INFO)

class CanopusRobo:
    def __init__(self):
        self.root = tk.Tk()
        self.root.title("ROBÔ CANOPUS - Monitor de Reservas")
        self.root.geometry("900x700")
        
        self.is_running = False
        self.session = None
        self.cookies = {}
        self.grupos_config = {}
        
        self.setup_ui()
    
    def setup_ui(self):
        # Frame de Configuração
        config_frame = tk.LabelFrame(self.root, text="Configurações", padx=10, pady=10)
        config_frame.pack(fill='x', padx=10, pady=5)
        
        tk.Label(config_frame, text="Usuário:").grid(row=0, column=0, sticky='w')
        self.user_entry = tk.Entry(config_frame, width=40)
        self.user_entry.grid(row=0, column=1, padx=5, pady=3)
        
        tk.Label(config_frame, text="Senha:").grid(row=1, column=0, sticky='w')
        self.pass_entry = tk.Entry(config_frame, show="*", width=40)
        self.pass_entry.grid(row=1, column=1, padx=5, pady=3)
        
        tk.Label(config_frame, text="Grupos (formato: 009113:3,009114:2):").grid(row=2, column=0, sticky='w')
        self.grupos_entry = tk.Entry(config_frame, width=60)
        self.grupos_entry.grid(row=2, column=1, padx=5, pady=3)
        
        tk.Label(config_frame, text="Delay Min (seg):").grid(row=3, column=0, sticky='w')
        self.delay_min = tk.DoubleVar(value=0.8)
        tk.Entry(config_frame, textvariable=self.delay_min, width=10).grid(row=3, column=1, sticky='w', padx=5)
        
        tk.Label(config_frame, text="Delay Max (seg):").grid(row=4, column=0, sticky='w')
        self.delay_max = tk.DoubleVar(value=3.5)
        tk.Entry(config_frame, textvariable=self.delay_max, width=10).grid(row=4, column=1, sticky='w', padx=5)
        
        # Botões
        btn_frame = tk.Frame(self.root)
        btn_frame.pack(pady=10)
        
        self.start_btn = tk.Button(btn_frame, text="▶ INICIAR ROBÔ", command=self.start_robô, bg="green", fg="white", font=("Arial", 10, "bold"), width=20)
        self.start_btn.pack(side='left', padx=5)
        
        self.stop_btn = tk.Button(btn_frame, text="⏹ PARAR", command=self.stop_robô, bg="red", fg="white", font=("Arial", 10, "bold"), width=15, state='disabled')
        self.stop_btn.pack(side='left', padx=5)
        
        # Área de Logs
        log_frame = tk.LabelFrame(self.root, text="Logs em Tempo Real", padx=10, pady=5)
        log_frame.pack(fill='both', expand=True, padx=10, pady=5)
        
        self.log_text = scrolledtext.ScrolledText(log_frame, height=25, font=("Consolas", 9))
        self.log_text.pack(fill='both', expand=True)
    
    def log(self, message, level="INFO"):
        timestamp = datetime.now().strftime("%H:%M:%S")
        color = "black"
        if "VAGA ENCONTRADA" in message:
            color = "green"
        elif "ERRO" in message or "FALHA" in message:
            color = "red"
        
        self.log_text.insert(tk.END, f"[{timestamp}] {message}\n")
        self.log_text.see(tk.END)
        self.root.update_idletasks()
    
    async def login(self):
        self.log("Tentando login no Canopus...")
        # TODO: Implementar login via aiohttp /auth/enterPlataforma
        pass
    
    async def monitorar_grupos(self):
        while self.is_running:
            try:
                self.log("Consultando grupos disponíveis...")
                # TODO: Chamar /reservas/listGruposReserva/{idUsuario}
                await asyncio.sleep(random.uniform(self.delay_min.get(), self.delay_max.get()))
            except Exception as e:
                self.log(f"ERRO no monitoramento: {e}", "ERROR")
                await asyncio.sleep(5)
    
    def start_robô(self):
        if self.is_running:
            return
        
        self.is_running = True
        self.start_btn.config(state='disabled')
        self.stop_btn.config(state='normal')
        
        self.log("🚀 Robô Canopus iniciado!")
        
        # Rodar asyncio em thread separada
        threading.Thread(target=self.run_async, daemon=True).start()
    
    def run_async(self):
        asyncio.run(self.main_loop())
    
    async def main_loop(self):
        async with aiohttp.ClientSession(connector=TCPConnector(ssl=False)) as session:
            self.session = session
            await self.login()
            await self.monitorar_grupos()
    
    def stop_robô(self):
        self.is_running = False
        self.log("⏹ Robô parado pelo usuário.")
        self.start_btn.config(state='normal')
        self.stop_btn.config(state='disabled')

if __name__ == "__main__":
    app = CanopusRobo()
    app.root.mainloop()
