using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Threading;
using Microsoft.Win32;

class InstallerWindow : Window {
  readonly Scene scene = new Scene();
  readonly Button action = new Button();
  readonly TextBlock status = new TextBlock();
  readonly ProgressBar progress = new ProgressBar();
  readonly DispatcherTimer timer = new DispatcherTimer();
  readonly Stopwatch clock = Stopwatch.StartNew();
  bool installing, complete, launchAttempted;
  double completedAt;

  [STAThread] static int Main(string[] args) {
    if (args.Any(a => a.Equals("/S", StringComparison.OrdinalIgnoreCase))) { try { return Install(args); } catch { return 1; } }
    var app = new Application(); app.Run(new InstallerWindow()); return 0;
  }
  static int Install(string[] args) {
    string dir = Path.Combine(Path.GetTempPath(), "branch-review-setup-" + Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(dir);
    try {
      string payload = Path.Combine(dir, "installer.exe");
      using (Stream source = Assembly.GetExecutingAssembly().GetManifestResourceStream("installer.exe"))
      using (FileStream target = File.Create(payload)) { if (source == null) throw new IOException("Installer payload is missing."); source.CopyTo(target); }
      string command = String.Join(" ", args.Select(a => a.StartsWith("/D=", StringComparison.OrdinalIgnoreCase) ? a : (a.IndexOf(' ') >= 0 ? "\"" + a.Replace("\"", "\\\"") + "\"" : a)));
      using (Process child = Process.Start(new ProcessStartInfo(payload, command) { UseShellExecute = false, CreateNoWindow = true })) { child.WaitForExit(); return child.ExitCode; }
    } finally { try { Directory.Delete(dir, true); } catch { } }
  }
  InstallerWindow() {
    Title = "Install Branch Review"; Width = 860; Height = 670; MinWidth = 680; MinHeight = 570;
    WindowStartupLocation = WindowStartupLocation.CenterScreen; Background = Brushes.Black;
    var grid = new Grid(); Content = grid; grid.Children.Add(scene);
    var overlay = new Grid { Margin = new Thickness(44, 36, 44, 30) }; grid.Children.Add(overlay);
    overlay.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
    overlay.RowDefinitions.Add(new RowDefinition());
    overlay.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
    var brand = new TextBlock { Text = "BRANCH REVIEW", Foreground = Brush("#DCD5FF"), FontFamily = new FontFamily("Segoe UI"), FontSize = 12, FontWeight = FontWeights.SemiBold };
    overlay.Children.Add(brand);
    var bottom = new StackPanel { HorizontalAlignment = HorizontalAlignment.Center, Width = 360 }; Grid.SetRow(bottom, 2); overlay.Children.Add(bottom);
    var title = new TextBlock { Text = "A clearer way to review.", TextAlignment = TextAlignment.Center, FontFamily = new FontFamily("Georgia"), Foreground = Brushes.White, FontSize = 27, Margin = new Thickness(0, 0, 0, 10) }; bottom.Children.Add(title);
    status.Text = "Your workspace is ready to install."; status.TextAlignment = TextAlignment.Center; status.Foreground = Brush("#C7C0E4"); status.FontSize = 13; status.TextWrapping = TextWrapping.Wrap; status.Margin = new Thickness(0, 0, 0, 20); bottom.Children.Add(status);
    progress.Height = 4; progress.IsIndeterminate = true; progress.Visibility = Visibility.Collapsed; progress.Margin = new Thickness(0, 0, 0, 16); bottom.Children.Add(progress);
    action.Content = "Install Branch Review"; action.Height = 46; action.Background = Brush("#F3EAFF"); action.Foreground = Brush("#28194C"); action.BorderThickness = new Thickness(0); action.FontWeight = FontWeights.SemiBold; action.Cursor = System.Windows.Input.Cursors.Hand; action.Click += BeginInstall; bottom.Children.Add(action);
    timer.Interval = TimeSpan.FromMilliseconds(33); timer.Tick += Tick; timer.Start();
    Closing += (sender, e) => { if (installing && !complete) e.Cancel = true; };
  }
  static SolidColorBrush Brush(string value) { return (SolidColorBrush)new BrushConverter().ConvertFromString(value); }
  static string InstalledApp() {
    using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\11871f03-e2b8-59f7-9569-da2b0e6c3dd8")) {
      string command = key == null ? null : key.GetValue("UninstallString") as string;
      if (!String.IsNullOrEmpty(command) && command[0] == '"') {
        int end = command.IndexOf('"', 1);
        if (end > 1) {
          string uninstaller = command.Substring(1, end - 1);
          if (String.Equals(Path.GetFileName(uninstaller), "Uninstall Branch Review.exe", StringComparison.OrdinalIgnoreCase)) {
            string executable = Path.Combine(Path.GetDirectoryName(uninstaller), "Branch Review.exe");
            if (File.Exists(executable)) return executable;
          }
        }
      }
    }
    return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Branch Review", "Branch Review.exe");
  }
  async void BeginInstall(object sender, RoutedEventArgs e) {
    installing = true; action.Visibility = Visibility.Collapsed; progress.Visibility = Visibility.Visible; status.Text = "Installing Branch Review…";
    try {
      int code = await Task.Run(() => Install(new string[] { "/S" }));
      if (code != 0) throw new Exception("The installer returned error " + code + ".");
      complete = true; progress.Visibility = Visibility.Collapsed; completedAt = clock.Elapsed.TotalSeconds; status.Text = "Installed. Opening Branch Review…";
    } catch (Exception error) {
      installing = false; progress.Visibility = Visibility.Collapsed; status.Text = "Installation didn't finish. " + error.Message; action.Content = "Try again"; action.Visibility = Visibility.Visible;
    }
  }
  void Tick(object sender, EventArgs e) {
    scene.Time = clock.Elapsed.TotalSeconds; scene.Open = complete ? Math.Min(1, (scene.Time - completedAt) / 1.5) : 0; scene.InvalidateVisual();
    if (complete && !launchAttempted && scene.Open >= 1) {
      launchAttempted = true;
      try { Process.Start(InstalledApp()); Close(); }
      catch (Exception error) { installing = false; status.Text = "Installed, but couldn't open the app. " + error.Message; action.Content = "Close"; action.Visibility = Visibility.Visible; action.Click -= BeginInstall; action.Click += (s, a) => Close(); }
    }
  }
}

class Scene : FrameworkElement {
  public double Time, Open;
  static SolidColorBrush B(string color) { return (SolidColorBrush)new BrushConverter().ConvertFromString(color); }
  Point P(double x, double y, double z, double angle, double scale, double cx, double cy) {
    double xr=x*Math.Cos(angle)+z*Math.Sin(angle), zr=-x*Math.Sin(angle)+z*Math.Cos(angle);
    return new Point(cx+xr*scale,cy+(y+zr*.27)*scale);
  }
  void Polygon(DrawingContext dc, Brush fill, Pen pen, Point[] points) {
    var shape=new StreamGeometry(); using(var g=shape.Open()){g.BeginFigure(points[0],true,true);g.PolyLineTo(points.Skip(1).ToArray(),true,false);} shape.Freeze(); dc.DrawGeometry(fill,pen,shape);
  }
  protected override void OnRender(DrawingContext dc) {
    double w=ActualWidth,h=ActualHeight,cx=w/2,cy=h*.43,scale=Math.Min(w,h)*.19;
    var background=new RadialGradientBrush(Color.FromRgb(46,29,116),Color.FromRgb(8,9,31)); background.Center=new Point(.5,.37);background.GradientOrigin=new Point(.5,.37);background.RadiusX=.8;background.RadiusY=.8;dc.DrawRectangle(background,null,new Rect(0,0,w,h));
    for(int i=0;i<34;i++){double x=((i*197)%997)/997.0*w,y=((i*349)%907)/907.0*h;dc.DrawEllipse(B(i%3==0?"#7C77A9":"#48416B"),null,new Point(x,y),i%7==0?1.3:.6,i%7==0?1.3:.6);}
    var halo=new RadialGradientBrush(Color.FromArgb((byte)(90+Open*90),179,81,255),Colors.Transparent);dc.DrawEllipse(halo,null,new Point(cx,cy+scale*.6),scale*2.1,scale*1.6);
    double a=Time*.55, s=scale*.75; var edge=new Pen(B("#B98CE1"),1);
    var faces=new[] {new[]{-1.0,1.0,1.0,1.0},new[]{-1.0,-1.0,1.0,-1.0},new[]{-1.0,-1.0,-1.0,1.0},new[]{1.0,-1.0,1.0,1.0}};
    foreach(var f in faces.OrderBy(v=>((-v[0]*Math.Sin(a)+v[1]*Math.Cos(a))+(-v[2]*Math.Sin(a)+v[3]*Math.Cos(a)))/2)) {
      var points=new[]{P(f[0],-.6,f[1],a,s,cx,cy),P(f[2],-.6,f[3],a,s,cx,cy),P(f[2],.8,f[3],a,s,cx,cy),P(f[0],.8,f[1],a,s,cx,cy)};
      Polygon(dc,B("#705B2FA6"),edge,points);
    }
    double lid=Open*1.25; var lidPoints=new[]{P(-1,-.6,-1,a,s,cx,cy),P(1,-.6,-1,a,s,cx,cy),P(1,-.6-2*Math.Sin(lid),-1+2*Math.Cos(lid),a,s,cx,cy),P(-1,-.6-2*Math.Sin(lid),-1+2*Math.Cos(lid),a,s,cx,cy)};
    Polygon(dc,B("#A97DE0"),edge,lidPoints);
    if(Open>0){var light=new RadialGradientBrush(Color.FromArgb((byte)(Open*210),255,220,255),Colors.Transparent);dc.DrawEllipse(light,null,new Point(cx,cy-s*.55),s*(.5+Open*2),s*(.5+Open*2));}
  }
}
