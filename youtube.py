from pytubefix import YouTube
import tkinter as tk
from tkinter import filedialog

def download_video(url, path):
    
    try:
        yt = YouTube(url)
        stream = yt.streams.filter(progressive=True, file_extension='mp4').order_by('resolution').desc().first()
        stream.download(output_path=path)
        print(f"Downloaded: {yt.title}")
    except Exception as e:
        print(f"Error downloading video: {e}")
        

url = "https://www.youtube.com/watch?v=VtMlrmJKnVQ"
path = ""

download_video(url, path)        