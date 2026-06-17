import { Link, Route, Routes } from 'react-router-dom';
import EditFueling from './routes/EditFueling';
import NewFueling from './routes/NewFueling';
import VehicleFuelings from './routes/VehicleFuelings';
import VehiclesHome from './routes/VehiclesHome';
import { isAuthEnabled, signOut } from './lib/auth';

export default function App() {
  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col">
      <header className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
        <Link to="/" className="text-lg font-semibold text-emerald-400">
          ⛽ Tankstelle
        </Link>
        {isAuthEnabled && (
          <button
            type="button"
            onClick={() => void signOut()}
            className="text-xs font-medium text-slate-400 hover:text-slate-200"
          >
            Sign out
          </button>
        )}
      </header>

      <main className="flex-1 overflow-y-auto px-4 py-4">
        <Routes>
          <Route path="/" element={<VehiclesHome />} />
          <Route path="/new" element={<NewFueling />} />
          <Route path="/vehicles/:id" element={<VehicleFuelings />} />
          <Route path="/fuelings/:id/edit" element={<EditFueling />} />
        </Routes>
      </main>
    </div>
  );
}
